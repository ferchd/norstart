import { AsyncLocalStorage } from "node:async_hooks";
import { SQL } from "bun";
import type { SelectQuery } from "../query/ast.ts";
import { compileQuery } from "../query/compiler.ts";
import type { CompiledQuery, SqlDialect } from "./contracts.ts";

export const SQL_OPTIONS = Symbol("norstar.sql.options");

export interface SqlClientOptions {
	readonly url: string;
	readonly dialect: SqlDialect;
	readonly maxConnections?: number;
	readonly connectionTimeoutSeconds?: number;
	readonly closeTimeoutSeconds?: number;
}

export interface SqlTransaction {
	execute<Row extends Record<string, unknown> = Record<string, unknown>>(
		query: SelectQuery,
	): Promise<readonly Row[]>;
}

type State = "new" | "connecting" | "ready" | "closing" | "closed";
type Binding = string | number | bigint | boolean | null;

function timeout(value: unknown, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 3600) {
		throw new Error("SQL timeouts must be finite seconds between zero and 3600");
	}

	return value;
}

function optionsSnapshot(input: SqlClientOptions): Readonly<Required<SqlClientOptions>> {
	if (typeof input !== "object" || input === null) {
		throw new Error("SQL client options are required");
	}
	const {
		url,
		dialect,
		maxConnections = 10,
		connectionTimeoutSeconds,
		closeTimeoutSeconds,
	} = input;
	if (typeof url !== "string" || url.length === 0 || url !== url.trim()) {
		throw new Error("An explicit SQL URL is required");
	}
	const protocols: Record<SqlDialect, readonly string[]> = {
		postgresql: ["postgres:", "postgresql:"],
		mysql: ["mysql:"],
		mariadb: ["mariadb:"],
		sqlite: ["sqlite:", "file:"],
	};
	if (!Object.hasOwn(protocols, dialect)) {
		throw new Error("Unsupported SQL dialect");
	}
	if (!(dialect === "sqlite" && url === ":memory:")) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error("Invalid SQL URL");
		}
		if (!protocols[dialect].includes(parsed.protocol)) {
			throw new Error("SQL URL does not match the configured dialect");
		}
		if (dialect !== "sqlite" && !parsed.hostname) {
			throw new Error("SQL network URLs require a hostname");
		}
	}
	if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 1000) {
		throw new Error("SQL maxConnections must be an integer between one and 1000");
	}

	return Object.freeze({
		url,
		dialect,
		maxConnections,
		connectionTimeoutSeconds: timeout(connectionTimeoutSeconds, 10),
		closeTimeoutSeconds: timeout(closeTimeoutSeconds, 5),
	});
}

function bindings(query: CompiledQuery, dialect: SqlDialect): Binding[] {
	return query.params.map((parameter) => {
		if (
			parameter.type === "bigint" &&
			(parameter.value < -(2n ** 63n) || parameter.value > 2n ** 63n - 1n)
		) {
			throw new Error("SQL bigint parameters must fit a signed 64-bit integer");
		}
		if (parameter.type === "boolean" && dialect === "sqlite") {
			return parameter.value ? 1 : 0;
		}

		return parameter.value;
	});
}

export class SqlClient {
	readonly #options: Readonly<Required<SqlClientOptions>>;
	readonly #transactionContext = new AsyncLocalStorage<boolean>();
	#state: State = "new";
	#native: SQL | undefined;
	#connecting: Promise<void> | undefined;
	#closing: Promise<void> | undefined;
	#queue: Promise<unknown> = Promise.resolve();
	readonly #operations = new Set<Promise<unknown>>();

	constructor(options: SqlClientOptions) {
		this.#options = optionsSnapshot(options);
	}

	#outsideTransaction(): void {
		if (this.#transactionContext.getStore()) {
			throw new Error("Use the SQL transaction handle inside its callback");
		}
	}

	#ready(): SQL {
		if (this.#state !== "ready" || this.#native === undefined) {
			throw new Error("SQL client is not connected or is closed");
		}

		return this.#native;
	}

	#createNative(): SQL {
		const options = this.#options;
		if (options.dialect === "sqlite") {
			return new SQL({ adapter: "sqlite", filename: options.url, bigint: true });
		}
		const url = new URL(options.url);
		const username =
			decodeURIComponent(url.username) ||
			(options.dialect === "postgresql" ? "postgres" : "root");

		return new SQL({
			adapter: options.dialect === "postgresql" ? "postgres" : options.dialect,
			url: options.url,
			hostname: url.hostname,
			port: url.port || (options.dialect === "postgresql" ? 5432 : 3306),
			username,
			password: decodeURIComponent(url.password),
			database:
				decodeURIComponent(url.pathname.slice(1)) ||
				(options.dialect === "postgresql" ? username : ""),
			max: options.maxConnections,
			connectionTimeout: options.connectionTimeoutSeconds,
			bigint: true,
		});
	}

	async connect(signal?: AbortSignal): Promise<void> {
		this.#outsideTransaction();
		if (signal?.aborted) {
			await this.close();
			throw new Error("SQL connection was cancelled");
		}
		if (this.#state === "closing" || this.#state === "closed") {
			throw new Error("SQL client is closed");
		}
		if (this.#state === "ready") {
			return;
		}
		let cancel!: (error: Error) => void;
		const cancelled = new Promise<never>((_, reject) => {
			cancel = reject;
		});
		const abort = (): void => {
			cancel(new Error("SQL connection was cancelled"));
			void this.close().catch(() => {});
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			if (this.#connecting === undefined) {
				this.#state = "connecting";
				this.#connecting = this.#connect();
			}
			await Promise.race([this.#connecting, cancelled]);
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	async #connect(): Promise<void> {
		try {
			const native = this.#createNative();
			this.#native = native;
			await native.connect();
			if (this.#state !== "connecting") {
				throw new Error("SQL client is closed");
			}
			this.#state = "ready";
		} catch {
			if (this.#state === "connecting") {
				this.#state = "closing";
				await this.#native?.close({ timeout: 0 }).catch(() => {});
				this.#state = "closed";
			}
			throw new Error("SQL connection failed or was cancelled");
		}
	}

	#schedule<T>(operation: () => Promise<T>): Promise<T> {
		const result =
			this.#options.dialect === "sqlite" ? this.#queue.then(operation) : operation();
		if (this.#options.dialect === "sqlite") {
			this.#queue = result.catch(() => {});
		}
		this.#operations.add(result);
		void result.then(
			() => this.#operations.delete(result),
			() => this.#operations.delete(result),
		);

		return result;
	}

	async #execute<Row extends Record<string, unknown>>(
		native: SQL,
		query: CompiledQuery,
	): Promise<readonly Row[]> {
		const parameters = bindings(query, this.#options.dialect);
		try {
			const rows = await native.unsafe<Row[]>(query.text, parameters);

			return Object.freeze(
				Array.from(rows, (row) => {
					if (this.#options.dialect !== "sqlite") {
						return row;
					}
					const entries = Object.entries(row).map(([key, value]) => {
						const normalized =
							typeof value === "bigint" &&
							value >= BigInt(Number.MIN_SAFE_INTEGER) &&
							value <= BigInt(Number.MAX_SAFE_INTEGER)
								? Number(value)
								: value;

						return [key, normalized];
					});

					return Object.fromEntries(entries) as Row;
				}),
			);
		} catch {
			throw new Error("SQL query failed");
		}
	}

	execute<Row extends Record<string, unknown> = Record<string, unknown>>(
		query: SelectQuery,
	): Promise<readonly Row[]> {
		try {
			this.#outsideTransaction();
			const native = this.#ready();
			const compiled = compileQuery(query, this.#options.dialect);

			return this.#schedule(() => this.#execute<Row>(native, compiled));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async transaction<T>(callback: (transaction: SqlTransaction) => T | Promise<T>): Promise<T> {
		this.#outsideTransaction();
		const native = this.#ready();
		if (typeof callback !== "function") {
			throw new Error("SQL transactions require a callback");
		}

		return this.#schedule(async () => {
			let callbackFailed = false;
			let callbackError: unknown;
			try {
				return await native.begin(async (connection) => {
					let active = true;
					const pending: Promise<unknown>[] = [];
					const handle: SqlTransaction = Object.freeze({
						execute: <Row extends Record<string, unknown>>(
							query: SelectQuery,
						): Promise<readonly Row[]> => {
							const operation = (async (): Promise<readonly Row[]> => {
								if (!active) {
									throw new Error("SQL transaction handle has expired");
								}
								const compiled = compileQuery(query, this.#options.dialect);

								return this.#execute<Row>(connection, compiled);
							})();
							pending.push(operation);
							void operation.catch(() => {});

							return operation;
						},
					});
					let result!: T;
					try {
						result = await this.#transactionContext.run(true, () => callback(handle));
					} catch (error) {
						callbackFailed = true;
						callbackError = error;
					} finally {
						active = false;
					}
					const results = await Promise.allSettled(pending);
					const failure = results.find((entry) => entry.status === "rejected");
					if (!callbackFailed && failure?.status === "rejected") {
						callbackFailed = true;
						callbackError = failure.reason;
					}
					if (callbackFailed) {
						throw callbackError;
					}

					return result;
				});
			} catch {
				if (callbackFailed) {
					throw callbackError;
				}
				throw new Error("SQL transaction failed");
			}
		});
	}

	close(): Promise<void> {
		try {
			this.#outsideTransaction();
		} catch (error) {
			return Promise.reject(error);
		}
		if (this.#closing !== undefined) {
			return this.#closing;
		}
		const connecting = this.#state === "connecting";
		this.#state = "closing";
		this.#closing = (async () => {
			const deadline = Date.now() + this.#options.closeTimeoutSeconds * 1000;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				if (
					!connecting &&
					this.#operations.size > 0 &&
					this.#options.closeTimeoutSeconds > 0
				) {
					await Promise.race([
						Promise.allSettled(this.#operations),
						new Promise<void>((resolve) => {
							timer = setTimeout(resolve, this.#options.closeTimeoutSeconds * 1000);
						}),
					]);
				}
				await this.#native?.close({
					timeout: connecting ? 0 : Math.max(0, (deadline - Date.now()) / 1000),
				});
			} catch {
				throw new Error("SQL client close failed");
			} finally {
				clearTimeout(timer);
				this.#state = "closed";
			}
		})();

		return this.#closing;
	}

	dispose(): Promise<void> {
		return this.close();
	}
}
