import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { column, compare, identifier, selectQuery } from "../../src/query/index.ts";
import { SqlClient, parameter } from "../../src/sql/index.ts";
import type { SelectQuery } from "../../src/query/index.ts";
import type { SqlTransaction } from "../../src/sql/index.ts";
import type { SqlClientOptions } from "../../src/sql/index.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});

	return { promise, resolve };
}

const hostile = "O'Reilly'); DROP TABLE records; --";
const records = identifier("records");
const recordId = column(identifier("id"));

function queryById(value = 1): SelectQuery {
	return selectQuery({
		from: { name: records },
		columns: [{ expression: recordId }, { expression: column(identifier("name")) }],
		where: compare("eq", recordId, parameter("integer", value)),
	});
}

async function fixture(options: Partial<SqlClientOptions> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "norstar-sql-client-"));
	const file = join(directory, "database.sqlite");
	const database = new Database(file);
	try {
		database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
		database.query("INSERT INTO records (id, name) VALUES (?, ?)").run(1, hostile);
	} finally {
		database.close();
	}
	const client = new SqlClient({
		url: `sqlite://${file.replaceAll("\\", "/")}`,
		dialect: "sqlite",
		...options,
	});

	return {
		client,
		async cleanup() {
			await client.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("does not open SQLite resources during construction and closes idempotently", async () => {
	const directory = await mkdtemp(join(tmpdir(), "norstar-sql-lazy-"));
	const file = join(directory, "unopened.sqlite");
	const client = new SqlClient({
		url: `sqlite://${file.replaceAll("\\", "/")}`,
		dialect: "sqlite",
	});
	try {
		expect(existsSync(file)).toBe(false);
		await expect(client.execute(queryById())).rejects.toThrow();
		await Promise.all([client.close(), client.close(), client.dispose()]);
		expect(existsSync(file)).toBe(false);
		await expect(client.connect()).rejects.toThrow();
	} finally {
		await client.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("executes validated SQLite AST bindings and preserves hostile text as data", async () => {
	const { client, cleanup } = await fixture();
	try {
		await Promise.all([client.connect(), client.connect()]);
		expect(await client.execute(queryById())).toEqual([{ id: 1, name: hostile }]);
		const query = selectQuery({
			from: { name: records },
			columns: [
				{ expression: parameter("boolean", true), alias: identifier("enabled") },
				{ expression: parameter("decimal", "12.50"), alias: identifier("amount") },
				{
					expression: parameter("timestamp", "2026-11-01T12:00:00.000Z"),
					alias: identifier("created"),
				},
				{ expression: parameter("null", null), alias: identifier("missing") },
			],
		});

		expect(await client.execute(query)).toEqual([
			{ enabled: 1, amount: "12.50", created: "2026-11-01T12:00:00.000Z", missing: null },
		]);
		expect(await client.execute(queryById())).toEqual([{ id: 1, name: hostile }]);
	} finally {
		await cleanup();
	}
});

test("rejects raw SQL and precompiled SQL objects at the execution boundary", async () => {
	const { client, cleanup } = await fixture();
	try {
		await client.connect();
		for (const input of ["DROP TABLE records", { text: "SELECT * FROM records", params: [] }]) {
			await expect(client.execute(input as unknown as SelectQuery)).rejects.toThrow();
		}
		expect(await client.execute(queryById())).toEqual([{ id: 1, name: hostile }]);
	} finally {
		await cleanup();
	}
});

test("captures mutable input parameters before asynchronous execution", async () => {
	const { client, cleanup } = await fixture();
	try {
		await client.connect();
		const value = { kind: "parameter" as const, type: "integer" as const, value: 1 };
		const query = {
			...queryById(),
			where: {
				kind: "comparison" as const,
				operator: "eq" as const,
				left: recordId,
				right: value,
			},
		};
		const execution = client.execute(query);
		value.value = 2;

		expect(await execution).toEqual([{ id: 1, name: hostile }]);
	} finally {
		await cleanup();
	}
});

test("transactions return callback values, reject failures, and expire their handles", async () => {
	const { client, cleanup } = await fixture();
	let expired: SqlTransaction | undefined;
	try {
		await client.connect();
		const result = await client.transaction(async (transaction) => {
			expired = transaction;
			expect(await transaction.execute(queryById())).toEqual([{ id: 1, name: hostile }]);

			return "committed";
		});
		expect(result).toBe("committed");
		expect(expired).toBeDefined();
		await expect(expired!.execute(queryById())).rejects.toThrow();
		const failure = new Error("callback failed");
		await expect(
			client.transaction(async (transaction) => {
				await transaction.execute(queryById());
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(await client.execute(queryById())).toEqual([{ id: 1, name: hostile }]);
	} finally {
		await cleanup();
	}
});

test("rejects root client operations inside its transaction callback without deadlock", async () => {
	const { client, cleanup } = await fixture();
	try {
		await client.connect();
		await client.transaction(async (transaction) => {
			await expect(client.execute(queryById())).rejects.toThrow();
			await expect(client.transaction(() => undefined)).rejects.toThrow();
			await expect(client.connect()).rejects.toThrow();
			await expect(client.close()).rejects.toThrow();
			expect(await transaction.execute(queryById())).toHaveLength(1);
		});
	} finally {
		await cleanup();
	}
});

test("queues unrelated root SQLite execution outside an active transaction", async () => {
	const { client, cleanup } = await fixture();
	const entered = deferred();
	const release = deferred();
	const events: string[] = [];
	try {
		await client.connect();
		const transaction = client.transaction(async (scope) => {
			await scope.execute(queryById());
			entered.resolve();
			await release.promise;
			events.push("transaction");
		});
		await entered.promise;
		const outside = client.execute(queryById()).then((rows) => {
			events.push("outside");

			return rows;
		});
		await Bun.sleep(10);
		expect(events).toEqual([]);
		release.resolve();
		await transaction;
		expect(await outside).toEqual([{ id: 1, name: hostile }]);
		expect(events).toEqual(["transaction", "outside"]);
	} finally {
		release.resolve();
		await cleanup();
	}
});

test("close waits for active transactions and rejects subsequent execution", async () => {
	const { client, cleanup } = await fixture();
	const entered = deferred();
	const release = deferred();
	let closed = false;
	try {
		await client.connect();
		const transaction = client.transaction(async (scope) => {
			entered.resolve();
			await release.promise;

			return scope.execute(queryById());
		});
		await entered.promise;
		const closing = client.close().then(() => {
			closed = true;
		});
		await Bun.sleep(10);
		expect(closed).toBe(false);
		await expect(client.execute(queryById())).rejects.toThrow();
		release.resolve();
		expect(await transaction).toEqual([{ id: 1, name: hostile }]);
		await closing;
		expect(closed).toBe(true);
		await expect(client.connect()).rejects.toThrow();
	} finally {
		release.resolve();
		await cleanup();
	}
});

test("rejects an already aborted connection attempt and a connect-close race safely", async () => {
	const { client, cleanup } = await fixture();
	const racing = new SqlClient({ url: ":memory:", dialect: "sqlite" });
	try {
		await expect(client.connect(AbortSignal.abort())).rejects.toThrow();
		const connecting = racing.connect();
		const closing = racing.close();
		await Promise.allSettled([connecting, closing]);
		await closing;
		await expect(racing.execute(queryById())).rejects.toThrow();
	} finally {
		await racing.close();
		await cleanup();
	}
});

test.each([
	{ url: "", dialect: "sqlite" },
	{ url: "sqlite://:memory:", dialect: "postgresql" },
	{ url: "postgres://user:secret@localhost/database", dialect: "mysql" },
	{ url: "mysql://user:secret@localhost/database", dialect: "mariadb" },
	{ url: ":memory:", dialect: "oracle" },
	{ url: ":memory:", dialect: "sqlite", maxConnections: 0 },
	{ url: ":memory:", dialect: "sqlite", maxConnections: 1.5 },
	{ url: ":memory:", dialect: "sqlite", connectionTimeoutSeconds: Number.NaN },
	{ url: ":memory:", dialect: "sqlite", closeTimeoutSeconds: -1 },
] as const)("rejects invalid explicit client options %#", (options) => {
	expect(() => new SqlClient(options as unknown as SqlClientOptions)).toThrow();
});

test("rejects oversized native bigint bindings without losing client usability", async () => {
	const { client, cleanup } = await fixture();
	try {
		await client.connect();
		for (const value of [-(2n ** 63n) - 1n, 2n ** 63n]) {
			const query = selectQuery({
				from: { name: records },
				columns: [{ expression: parameter("bigint", value) }],
			});
			await expect(client.execute(query)).rejects.toThrow();
		}
		expect(await client.execute(queryById())).toHaveLength(1);
	} finally {
		await cleanup();
	}
});

test("preserves SQLite bigint precision while returning safe integers as numbers", async () => {
	const { client, cleanup } = await fixture();
	try {
		await client.connect();
		const query = selectQuery({
			from: { name: records },
			columns: [
				{ expression: parameter("bigint", 9007199254740993n), alias: identifier("large") },
				{ expression: parameter("bigint", -(2n ** 63n)), alias: identifier("minimum") },
				{ expression: parameter("bigint", 2n ** 63n - 1n), alias: identifier("maximum") },
				{ expression: recordId },
			],
		});

		expect(await client.execute(query)).toEqual([
			{ large: 9007199254740993n, minimum: -(2n ** 63n), maximum: 2n ** 63n - 1n, id: 1 },
		]);
	} finally {
		await cleanup();
	}
});

test("drains root queries and transactions accepted before close begins", async () => {
	const { client, cleanup } = await fixture();
	const entered = deferred();
	const release = deferred();
	try {
		await client.connect();
		const first = client.transaction(async (transaction) => {
			entered.resolve();
			await release.promise;

			return transaction.execute(queryById());
		});
		await entered.promise;
		const queuedQuery = client.execute(queryById());
		const queuedTransaction = client.transaction((transaction) =>
			transaction.execute(queryById()),
		);
		const closing = client.close();
		await expect(client.execute(queryById())).rejects.toThrow();
		release.resolve();

		for (const operation of [first, queuedQuery, queuedTransaction]) {
			expect(await operation).toEqual([{ id: 1, name: hostile }]);
		}
		await closing;
		await expect(client.connect()).rejects.toThrow();
	} finally {
		release.resolve();
		await cleanup();
	}
});

test("bounds forced close and prevents a late transaction callback from reopening the client", async () => {
	const { client, cleanup } = await fixture({ closeTimeoutSeconds: 0.02 });
	const entered = deferred();
	const release = deferred();
	try {
		await client.connect();
		const transaction = client.transaction(async (scope) => {
			entered.resolve();
			await release.promise;

			return scope.execute(queryById());
		});
		const transactionOutcome = transaction.then(
			() => "fulfilled",
			() => "rejected",
		);
		await entered.promise;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				client.close(),
				new Promise<never>((_, reject) => {
					deadline = setTimeout(() => {
						reject(new Error("Closing waited indefinitely for a blocked callback"));
					}, 1500);
				}),
			]);
		} finally {
			clearTimeout(deadline);
		}
		await expect(client.connect()).rejects.toThrow();
		release.resolve();
		expect(await transactionOutcome).toBe("rejected");
		await expect(client.execute(queryById())).rejects.toThrow();
	} finally {
		release.resolve();
		await cleanup();
	}
});

test("cancels a pending native connection without exposing credentials or reopening", async () => {
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data() {},
		},
	});
	const secret = "norstar_password_do_not_expose";
	const url = `postgres://test:${secret}@127.0.0.1:${server.port}/test`;
	const client = new SqlClient({ url, dialect: "postgresql", connectionTimeoutSeconds: 1 });
	const controller = new AbortController();
	try {
		expect(Bun.inspect(client)).not.toContain(secret);
		expect(JSON.stringify(client)).not.toContain(secret);
		const connecting = client.connect(controller.signal);
		controller.abort();
		let failure: unknown;
		try {
			await connecting;
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).not.toContain(secret);
		expect(String(failure)).not.toContain(url);
		await expect(client.connect()).rejects.toThrow();
	} finally {
		await client.close();
		server.stop(true);
	}
});

test("drains issued transaction operations and rejects a swallowed query failure", async () => {
	const { client, cleanup } = await fixture();
	const events: string[] = [];
	try {
		await client.connect();
		await client.transaction((transaction) => {
			void transaction.execute(queryById()).then((rows) => {
				expect(rows).toHaveLength(1);
				events.push("query");
			});
		});
		events.push("transaction");
		expect(events).toEqual(["query", "transaction"]);
		const missing = selectQuery({
			from: { name: identifier("missing_table") },
			columns: [{ expression: recordId }],
		});
		await expect(
			client.transaction((transaction) => {
				void transaction.execute(missing).catch(() => undefined);
			}),
		).rejects.toThrow();
		expect(await client.execute(queryById())).toHaveLength(1);
	} finally {
		await cleanup();
	}
});
