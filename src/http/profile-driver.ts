import type { ProfileContext, ProfileDriver, ProfileInstance } from "../core/contracts.ts";
import { HttpRouter } from "./router.ts";

interface HttpProfileConfiguration {
	readonly port: number;
	readonly hostname: string;
	readonly routes: unknown;
}

export class HttpProfileInstance implements ProfileInstance {
	readonly mode = "persistent" as const;
	readonly finished: Promise<void>;
	private finish!: () => void;
	private server?: ReturnType<typeof Bun.serve>;
	private stopped = false;
	private stopPromise?: Promise<void>;

	constructor(
		private readonly configuration: HttpProfileConfiguration,
		private readonly router: HttpRouter,
		private readonly context: ProfileContext,
	) {
		this.finished = new Promise((resolve) => {
			this.finish = resolve;
		});
	}

	get port(): number | undefined {
		return this.server?.port;
	}

	start(signal: AbortSignal): void {
		if (this.stopped) {
			throw new Error("HTTP profile has already been stopped");
		}
		if (this.server) {
			throw new Error("HTTP profile has already been started");
		}
		if (signal.aborted) {
			throw new Error("HTTP profile startup was aborted");
		}

		this.server = Bun.serve({
			hostname: this.configuration.hostname,
			port: this.configuration.port,
			routes: this.router.createBunRoutes(this.context.createScope),
			fetch: () => this.router.handleNotFound(this.context.createScope),
		});
	}

	stop(signal: AbortSignal): Promise<void> {
		if (!this.stopPromise) {
			this.stopPromise = this.shutdown(signal);
		}

		return this.stopPromise;
	}

	private async shutdown(signal: AbortSignal): Promise<void> {
		this.stopped = true;
		const server = this.server;
		this.server = undefined;
		let abortHandler: (() => void) | undefined;

		try {
			if (!server) {
				return;
			}

			if (signal.aborted) {
				await server.stop(true);

				return;
			}

			const forced = new Promise<boolean>((resolve) => {
				abortHandler = () => resolve(true);
				signal.addEventListener("abort", abortHandler, { once: true });

				if (signal.aborted) {
					abortHandler();
				}
			});
			const graceful = server.stop().then(() => false);
			let forceRequired: boolean;
			try {
				forceRequired = await Promise.race([graceful, forced]);
			} catch (error) {
				try {
					await server.stop(true);
				} catch (forceError) {
					throw new AggregateError(
						[error, forceError],
						"HTTP server graceful and forced shutdown both failed",
						{ cause: forceError },
					);
				}

				throw error;
			}

			if (forceRequired) {
				await server.stop(true);
			}
		} finally {
			if (abortHandler) {
				signal.removeEventListener("abort", abortHandler);
			}

			this.finish();
		}
	}
}

export class HttpProfileDriver implements ProfileDriver {
	readonly type = "http-server";

	async create(context: ProfileContext): Promise<HttpProfileInstance> {
		const configuration = readConfiguration(context.config);
		const router = await HttpRouter.load(configuration.routes);

		return new HttpProfileInstance(configuration, router, context);
	}
}

export const httpProfileDriver = new HttpProfileDriver();

function readConfiguration(config: Readonly<Record<string, unknown>>): HttpProfileConfiguration {
	const port = config.port ?? 3000;
	if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error("HTTP profile port must be an integer from 0 through 65535");
	}

	const hostname = config.hostname ?? "127.0.0.1";
	if (typeof hostname !== "string" || !hostname.trim()) {
		throw new Error("HTTP profile hostname must be a non-empty string");
	}

	return {
		port,
		hostname,
		routes: config.routes,
	};
}
