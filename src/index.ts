import { Application as CoreApplication } from "./core/application.ts";
import type { ApplicationOptions } from "./core/application.ts";
import { httpProfileDriver } from "./http/profile-driver.ts";

export class Application extends CoreApplication {
	static override configure(options: ApplicationOptions = {}) {
		const drivers = [...(options.drivers ?? [])];
		const hasHttpDriver = drivers.some((driver) => driver.type === httpProfileDriver.type);

		if (!hasHttpDriver) {
			drivers.push(httpProfileDriver);
		}

		return super.configure({ ...options, drivers });
	}
}

export {
	CircularDependencyError,
	Container,
	Kernel,
	ProfileRegistry,
	createManifest,
	loadConfiguration,
	loadConfigurationSync,
	parseConfiguration,
} from "./core/index.ts";
export type {
	ApplicationConfig,
	ApplicationManifest,
	ApplicationOptions,
	ExecutionMode,
	KernelState,
	ProfileContext,
	ProfileDefinition,
	ProfileDriver,
	ProfileInstance,
	ProfileRegistration,
	RunResult,
	ServiceContainer,
	ServiceLifetime,
	ServiceResolver,
	ServiceScope,
	ServiceToken,
	StopReason,
	CompiledApplicationDefinition,
} from "./core/index.ts";
