export type KernelState =
	| "created"
	| "bootstrapping"
	| "ready"
	| "starting"
	| "running"
	| "stopping"
	| "stopped"
	| "failed";

export type StopReason = "requested" | "signal" | "completed" | "failure";
export type ExecutionMode = "persistent" | "finite";
export type ServiceLifetime = "singleton" | "transient" | "scoped";

export interface RunResult {
	readonly status: "completed" | "stopped" | "failed";
	readonly exitCode: number;
	readonly reason: StopReason;
	readonly error?: unknown;
}

export interface ProfileInstance {
	readonly mode: ExecutionMode;
	readonly finished: Promise<void>;
	/** Must honor abort requests; if start settles after shutdown begins, the Kernel calls stop once. */
	start(signal: AbortSignal): void | Promise<void>;
	stop(signal: AbortSignal): void | Promise<void>;
}

export interface ProfileContext<TConfig extends object = Record<string, unknown>> {
	readonly id: string;
	readonly config: Readonly<TConfig>;
	readonly services: ServiceResolver;
	readonly signal: AbortSignal;
	createScope(): ServiceScope;
}

export interface ProfileDriver<TConfig extends object = Record<string, unknown>> {
	readonly type: string;
	/** Must honor abort requests and avoid registering resources after cancellation. */
	create(context: ProfileContext<TConfig>): ProfileInstance | Promise<ProfileInstance>;
}

export type ServiceToken<T> = symbol | (abstract new (...args: never[]) => T);

export interface ServiceResolver {
	get<T>(token: ServiceToken<T>): T;
}

export interface ServiceContainer extends ServiceResolver {
	createScope(): ServiceScope;
	dispose(): Promise<void>;
}

export interface ServiceScope extends ServiceResolver {
	dispose(): Promise<void>;
}

export interface ProfileDefinition {
	readonly type: string;
	readonly config: Readonly<Record<string, unknown>>;
}

export interface ApplicationConfig {
	readonly application: Readonly<{
		name?: string;
		serviceModules: readonly string[];
		profileDrivers?: readonly string[];
	}>;
	readonly profiles: Readonly<Record<string, ProfileDefinition>>;
}

export interface ProfileRegistration {
	readonly id: string;
	readonly type: string;
	readonly config: Readonly<Record<string, unknown>>;
}

export interface ApplicationManifest {
	readonly schemaVersion: number;
	readonly frameworkVersion: string;
	readonly serviceModules: readonly string[];
	readonly profiles: readonly ProfileRegistration[];
}

export interface KernelOptions {
	readonly config: ApplicationConfig;
	readonly manifest: ApplicationManifest;
	readonly drivers: readonly ProfileDriver[];
	readonly services: ServiceContainer;
	readonly shutdownTimeoutMs?: number;
}
