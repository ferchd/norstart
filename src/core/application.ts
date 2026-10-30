import type { ProfileDriver, RunResult, StopReason } from "./contracts.ts";
import { Container } from "./container.ts";
import { loadConfigurationSync } from "./configuration.ts";
import { Kernel } from "./kernel.ts";
import { createManifest } from "./manifest.ts";

export interface ApplicationOptions {
	readonly configPath?: string;
	readonly drivers?: readonly ProfileDriver[];
	readonly shutdownTimeoutMs?: number;
}

export class Application {
	private runPromise?: Promise<RunResult>;
	constructor(private readonly kernel: Kernel) {}

	static configure(options: ApplicationOptions = {}): ConfiguredApplication {
		return new ConfiguredApplication(options);
	}

	run(): Promise<RunResult> {
		if (this.runPromise) {
			return this.runPromise;
		}
		this.runPromise = this.execute();
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
		return this.kernel.stop(reason);
	}

	private async execute(): Promise<RunResult> {
		try {
			await this.kernel.bootstrap();
			await this.kernel.start();

			return await this.kernel.waitForExit();
		} catch (error) {
			await this.kernel.stop("failure");
			throw error;
		}
	}
}

class ConfiguredApplication {
	constructor(private readonly options: ApplicationOptions) {}

	create(): Application {
		const config = loadConfigurationSync(this.options.configPath);
		const kernel = new Kernel({
			config,
			manifest: createManifest(config),
			drivers: this.options.drivers ?? [],
			services: new Container(),
			shutdownTimeoutMs: this.options.shutdownTimeoutMs,
		});

		return new Application(kernel);
	}
}
