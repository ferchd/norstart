import type { ProfileDriver, RunResult, StopReason } from "./contracts.ts";
import { Container } from "./container.ts";
import { loadConfigurationSync } from "./configuration.ts";
import { Kernel } from "./kernel.ts";
import { createManifest } from "./manifest.ts";
import { registerServiceModules } from "./service-modules.ts";
import { getCompiledApplication } from "./compiled-application.ts";
import type { CompiledApplicationDefinition } from "./compiled-application.ts";
import { ExtensionManager } from "./extensions.ts";
import type { ApplicationExtension } from "./extensions.ts";

export interface ApplicationOptions {
	readonly compiled?: CompiledApplicationDefinition;
	readonly configPath?: string;
	readonly drivers?: readonly ProfileDriver[];
	readonly extensions?: readonly ApplicationExtension[];
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
		private readonly extensions?: ExtensionManager,
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
			await this.extensions?.initialize(signal);
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
		const compiled = this.options.compiled ?? getCompiledApplication();
		if (compiled && this.options.configPath) {
			throw new Error("A compiled application cannot override its configuration path");
		}

		const config = compiled?.config ?? loadConfigurationSync(this.options.configPath);
		const drivers = [...(this.options.drivers ?? []), ...(compiled?.drivers ?? [])];
		for (const driver of drivers) {
			if (
				!driver ||
				typeof driver.type !== "string" ||
				!driver.type.trim() ||
				typeof driver.create !== "function"
			) {
				throw new Error(
					"Compiled profile driver modules must default-export a ProfileDriver",
				);
			}
		}
		const services = new Container();
		const extensions = new ExtensionManager(
			[...(compiled?.extensions ?? []), ...(this.options.extensions ?? [])],
			services,
		);
		try {
			compiled?.registerServices(services);
			extensions.register();
			this.options.configureServices?.(services);
		} catch (error) {
			void services.dispose().catch(() => undefined);
			throw error;
		}
		const manifest = compiled?.manifest ?? createManifest(config);

		const kernel = new Kernel({
			config,
			manifest,
			drivers,
			services: extensions.container(),
			shutdownTimeoutMs: this.options.shutdownTimeoutMs,
		});

		return new Application(
			kernel,
			services,
			compiled ? [] : manifest.serviceModules,
			this.options.handleProcessSignals ?? true,
			extensions,
		);
	}
}
