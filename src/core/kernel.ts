import type {
	KernelOptions,
	KernelState,
	ProfileInstance,
	RunResult,
	StopReason,
} from "./contracts.ts";
import { ProfileRegistry } from "./manifest.ts";

type Completion =
	{ readonly status: "completed" } | { readonly status: "failed"; readonly error: unknown };
type FatalError = { readonly error: unknown };

export class Kernel {
	private currentState: KernelState = "created";
	private readonly registry: ProfileRegistry;
	private readonly bootstrapAbort = new AbortController();
	private readonly runAbort = new AbortController();
	private readonly instances: {
		id: string;
		instance: ProfileInstance;
		started: boolean;
		startPending: boolean;
		settled: boolean;
		stopPromise?: Promise<void>;
	}[] = [];
	private readonly completion: Promise<Completion>;
	private readonly stopRequested: Promise<void>;
	private complete!: (value: Completion) => void;
	private requestStop!: () => void;
	private completedCount = 0;
	private lifecycleOperation?: Promise<void>;
	private stopPromise?: Promise<RunResult>;
	private stopReason?: StopReason;
	private stopResult?: RunResult;
	private fatalError?: FatalError;
	private shutdownDeadline?: number;

	constructor(private readonly options: KernelOptions) {
		this.registry = new ProfileRegistry(options.drivers);
		this.completion = new Promise((resolve) => {
			this.complete = resolve;
		});
		this.stopRequested = new Promise((resolve) => {
			this.requestStop = resolve;
		});
	}

	get state(): KernelState {
		return this.currentState;
	}

	async bootstrap(): Promise<void> {
		if (this.currentState !== "created") {
			throw new Error(`Cannot bootstrap Kernel in state "${this.currentState}"`);
		}
		this.currentState = "bootstrapping";
		const operation = this.performBootstrap();
		this.lifecycleOperation = operation;
		const interrupted = this.stopPromise !== undefined;
		try {
			await this.waitForLifecycleOrStop(operation);
			if (!this.stopPromise) {
				this.currentState = "ready";
			}
		} catch (error) {
			if (!interrupted && !this.stopPromise) {
				this.fatalError = { error };
			}
			await this.stop(this.stopReason ?? "failure");
			if (!interrupted && this.fatalError) {
				throw error;
			}
		} finally {
			if (this.lifecycleOperation === operation) {
				this.lifecycleOperation = undefined;
			}
		}
	}

	private async performBootstrap(): Promise<void> {
		for (const definition of this.options.manifest.profiles) {
			if (this.stopPromise) {
				return;
			}
			const driver = this.registry.get(definition.type);
			const instance = await driver.create({
				id: definition.id,
				config: definition.config,
				services: this.options.services,
				signal: this.bootstrapAbort.signal,
			});
			if (this.stopPromise) {
				await this.cleanupLateInstance(instance);

				return;
			}
			const record = {
				id: definition.id,
				instance,
				started: false,
				startPending: false,
				settled: false,
			};
			this.instances.push(record);
			void instance.finished.then(
				() => {
					record.settled = true;
					this.completedCount++;
					if (this.stopPromise) {
						return;
					}
					if (instance.mode === "persistent") {
						const error = new Error(
							`Persistent profile "${record.id}" finished unexpectedly`,
						);
						this.fatalError = { error };
						this.resolveCompletion({ status: "failed", error });

						return;
					}
					this.updateCompletion();
				},
				(error: unknown) => {
					record.settled = true;
					this.completedCount++;
					if (this.stopPromise) {
						return;
					}
					this.fatalError = { error };
					this.resolveCompletion({ status: "failed", error });
				},
			);
		}
	}

	async start(): Promise<void> {
		if (this.stopPromise) {
			await this.stopPromise;

			return;
		}
		if (this.currentState !== "ready") {
			throw new Error(`Cannot start Kernel in state "${this.currentState}"`);
		}
		this.currentState = "starting";
		const operation = this.performStart();
		this.lifecycleOperation = operation;
		const interrupted = this.stopPromise !== undefined;
		try {
			await this.waitForLifecycleOrStop(operation);
			if (!this.stopPromise) {
				this.currentState = "running";
				this.updateCompletion();
			}
		} catch (error) {
			if (!interrupted && !this.stopPromise) {
				this.fatalError = { error };
			}
			await this.stop(this.stopReason ?? "failure");
			if (!interrupted && this.fatalError) {
				throw error;
			}
		} finally {
			if (this.lifecycleOperation === operation) {
				this.lifecycleOperation = undefined;
			}
		}
	}

	private async performStart(): Promise<void> {
		for (const record of this.instances) {
			if (this.stopPromise) {
				return;
			}
			const fatalErrorBeforeStart = this.getFatalError();
			if (fatalErrorBeforeStart) {
				throw fatalErrorBeforeStart.error;
			}
			record.started = true;
			record.startPending = true;
			try {
				await record.instance.start(this.runAbort.signal);
			} finally {
				record.startPending = false;
				if (this.stopPromise) {
					await this.stopInstance(record);
				}
			}
			const fatalErrorAfterStart = this.getFatalError();
			if (fatalErrorAfterStart) {
				throw fatalErrorAfterStart.error;
			}
		}
	}

	async waitForExit(): Promise<RunResult> {
		if (this.stopPromise) {
			return this.stopPromise;
		}
		if (this.currentState !== "running") {
			throw new Error(`Cannot wait for exit in state "${this.currentState}"`);
		}
		const result = await this.completion;
		if (result.status === "failed") {
			this.fatalError = { error: result.error };

			return this.stop("failure");
		}

		return this.stop("completed");
	}

	stop(reason: StopReason = "requested"): Promise<RunResult> {
		if (this.stopPromise) {
			return this.stopPromise;
		}
		if (this.currentState === "stopped" || this.currentState === "failed") {
			return Promise.resolve(this.stopResult ?? this.result(reason));
		}
		this.stopReason = reason;
		this.currentState = "stopping";
		this.bootstrapAbort.abort(reason);
		this.runAbort.abort(reason);
		this.resolveCompletion({ status: "completed" });
		this.shutdownDeadline = Date.now() + (this.options.shutdownTimeoutMs ?? 10_000);
		this.stopPromise = this.performStop(reason);
		this.requestStop();

		return this.stopPromise;
	}

	private async performStop(reason: StopReason): Promise<RunResult> {
		const timeoutMs = this.options.shutdownTimeoutMs ?? 10_000;
		const deadline = this.shutdownDeadline ?? Date.now() + timeoutMs;
		const errors: unknown[] = [];
		const lifecycleOperation = this.lifecycleOperation;
		if (lifecycleOperation) {
			try {
				await this.withTimeout(
					() => lifecycleOperation,
					Math.max(0, deadline - Date.now()),
					"Kernel lifecycle operation timed out during shutdown",
				);
			} catch (error) {
				errors.push(error);
			}
		}
		for (const record of [...this.instances].reverse()) {
			if (!record.started || record.startPending) {
				continue;
			}
			try {
				await this.stopInstance(record);
			} catch (error) {
				errors.push(error);
			}
		}
		try {
			await this.withTimeout(
				() => this.options.services.dispose(),
				Math.max(0, deadline - Date.now()),
				"Service disposal timed out during shutdown",
			);
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0 && !this.fatalError) {
			this.fatalError = {
				error: new AggregateError(errors, "Application shutdown failed"),
			};
		}
		this.currentState = this.fatalError ? "failed" : "stopped";
		const finalReason = this.fatalError ? "failure" : reason;
		this.stopResult = this.result(finalReason);

		return this.stopResult;
	}

	private updateCompletion(): void {
		if (this.currentState !== "running") {
			return;
		}
		if (this.fatalError) {
			this.resolveCompletion({ status: "failed", error: this.fatalError.error });

			return;
		}
		if (this.completedCount === this.instances.length) {
			this.resolveCompletion({ status: "completed" });
		}
	}

	private resolveCompletion(value: Completion): void {
		this.complete(value);
	}

	private getFatalError(): FatalError | undefined {
		return this.fatalError;
	}

	private result(reason: StopReason): RunResult {
		const failed = reason === "failure" || this.fatalError !== undefined;

		return Object.freeze({
			status: failed ? "failed" : reason === "completed" ? "completed" : "stopped",
			exitCode: failed ? 1 : 0,
			reason: failed ? "failure" : reason,
			...(this.fatalError === undefined ? {} : { error: this.fatalError.error }),
		});
	}

	private async waitForLifecycleOrStop(operation: Promise<void>): Promise<void> {
		const outcome = await Promise.race([
			operation.then(() => "completed" as const),
			this.stopRequested.then(() => "stopping" as const),
		]);

		if (outcome === "stopping" && this.stopPromise) {
			await this.stopPromise;
		}
	}

	private async cleanupLateInstance(instance: ProfileInstance): Promise<void> {
		try {
			await this.withTimeout(
				(signal) => instance.stop(signal),
				Math.max(0, (this.shutdownDeadline ?? Date.now()) - Date.now()),
				"Late profile cleanup timed out",
			);
		} catch (error) {
			if (!this.stopResult) {
				throw error;
			}
		}
	}

	private stopInstance(record: (typeof this.instances)[number]): Promise<void> {
		if (!record.stopPromise) {
			const deadline = this.shutdownDeadline ?? Date.now();
			record.stopPromise = this.withTimeout(
				(signal) => record.instance.stop(signal),
				Math.max(0, deadline - Date.now()),
				`Profile "${record.id}" shutdown timed out`,
			);
		}

		return record.stopPromise;
	}

	private async withTimeout<T>(
		operation: (signal: AbortSignal) => T | Promise<T>,
		timeoutMs: number,
		message: string,
	): Promise<T> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				Promise.resolve().then(() => operation(controller.signal)),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						controller.abort(new Error(message));
						reject(new Error(message));
					}, timeoutMs);
				}),
			]);
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
		}
	}
}
