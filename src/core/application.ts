import type { ProfileDriver, RunResult, StopReason } from "./contracts.ts";
import { Container } from "./container.ts";
import { loadConfigurationSync } from "./configuration.ts";
import { Kernel } from "./kernel.ts";
import { createManifest } from "./manifest.ts";
import { registerServiceModules } from "./service-modules.ts";

export interface ApplicationOptions {
	readonly configPath?: string;
	readonly drivers?: readonly ProfileDriver[];
	readonly configureServices?: (services: Container) => void;
	readonly handleProcessSignals?: boolean;
	readonly shutdownTimeoutMs?: number;
}

export class Application {
	private runPromise?: Promise<RunResult>;
	private readonly serviceLoadingAbort = new AbortController();
	private readonly signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();

	constructor(
		private readonly kernel: Kernel,
		private readonly services: Container,
		private readonly serviceModules: readonly string[],
		private readonly handleProcessSignals: boolean,
	) {}

	static configure(options: ApplicationOptions = {}): ConfiguredApplication {
		return new ConfiguredApplication(options);
	}

	run(): Promise<RunResult> {
		if (this.runPromise) {
			return this.runPromise;
		}

		if (this.handleProcessSignals) {
			this.installSignalHandlers();
		}

		this.runPromise = this.execute().finally(() => this.removeSignalHandlers());
		void this.runPromise
			.then((result) => {
				if (result.exitCode !== 0) {
					process.exitCode = result.exitCode;
					if (result.error !== undefined) {
						console.error("Fatal application error:", result.error);
					}
				}
			})
			.catch((error) => {
				console.error("Fatal application error:", error);
				process.exitCode = 1;
			});

		return this.runPromise;
	}

	stop(reason: StopReason = "requested"): Promise<RunResult> {
		this.serviceLoadingAbort.abort(reason);

		return this.kernel.stop(reason);
	}

	private async execute(): Promise<RunResult> {
		try {
			const signal = this.serviceLoadingAbort.signal;
			await registerServiceModules(this.serviceModules, this.services, signal);
			if (signal.aborted) {
				return await this.kernel.stop();
			}

			await this.kernel.bootstrap();
			await this.kernel.start();

			return await this.kernel.waitForExit();
		} catch (error) {
			await this.kernel.stop("failure");
			throw error;
		}
	}

	private installSignalHandlers(): void {
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			const handler = (): void => {
				void this.stop("signal");
			};
			this.signalHandlers.set(signal, handler);
			process.once(signal, handler);
		}
	}

	private removeSignalHandlers(): void {
		for (const [signal, handler] of this.signalHandlers) {
			process.removeListener(signal, handler);
		}

		this.signalHandlers.clear();
	}
}

class ConfiguredApplication {
	constructor(private readonly options: ApplicationOptions) {}

	create(): Application {
		const config = loadConfigurationSync(this.options.configPath);
		const services = new Container();
		this.options.configureServices?.(services);
		const manifest = createManifest(config);

		const kernel = new Kernel({
			config,
			manifest,
			drivers: this.options.drivers ?? [],
			services,
			shutdownTimeoutMs: this.options.shutdownTimeoutMs,
		});

		return new Application(
			kernel,
			services,
			manifest.serviceModules,
			this.options.handleProcessSignals ?? true,
		);
	}
}
