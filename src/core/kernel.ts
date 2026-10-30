import type {
	KernelOptions,
	KernelState,
	ProfileInstance,
	RunResult,
	StopReason,
} from "./contracts.ts";
import { ProfileRegistry } from "./manifest.ts";

type Completion = { readonly error?: unknown };

export class Kernel {
	private currentState: KernelState = "created";
	private readonly registry: ProfileRegistry;
	private readonly bootstrapAbort = new AbortController();
	private readonly runAbort = new AbortController();
	private readonly instances: {
		id: string;
		instance: ProfileInstance;
		started: boolean;
		settled: boolean;
	}[] = [];
	private readonly completion: Promise<Completion>;
	private complete!: (value: Completion) => void;
	private completedCount = 0;
	private lifecycleOperation?: Promise<void>;
	private stopPromise?: Promise<RunResult>;
	private stopReason?: StopReason;
	private stopResult?: RunResult;
	private fatalError?: unknown;

	constructor(private readonly options: KernelOptions) {
		this.registry = new ProfileRegistry(options.drivers);
		this.completion = new Promise((resolve) => {
			this.complete = resolve;
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
			await operation;
			if (!this.stopPromise) {
				this.currentState = "ready";
			}
		} catch (error) {
			if (!interrupted && !this.stopPromise) {
				this.fatalError = error;
			}
			await this.stop(this.stopReason ?? "failure");
			if (!interrupted && this.fatalError !== undefined) {
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
			const record = { id: definition.id, instance, started: false, settled: false };
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
						this.fatalError = error;
						this.resolveCompletion({ error });

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
					this.fatalError = error;
					this.resolveCompletion({ error });
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
			await operation;
			if (!this.stopPromise) {
				this.currentState = "running";
				this.updateCompletion();
			}
		} catch (error) {
			if (!interrupted && !this.stopPromise) {
				this.fatalError = error;
			}
			await this.stop(this.stopReason ?? "failure");
			if (!interrupted && this.fatalError !== undefined) {
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
			if (this.fatalError !== undefined) {
				throw this.fatalError;
			}
			record.started = true;
			await record.instance.start(this.runAbort.signal);
			if (this.fatalError !== undefined) {
				throw this.fatalError;
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
		if (result.error !== undefined) {
			this.fatalError = result.error;

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
		this.resolveCompletion({});
		this.stopPromise = this.performStop(reason);

		return this.stopPromise;
	}

	private async performStop(reason: StopReason): Promise<RunResult> {
		const lifecycleOperation = this.lifecycleOperation;
		if (lifecycleOperation) {
			try {
				await lifecycleOperation;
			} catch {
				// Continue cleanup after a bootstrap or start operation fails.
			}
		}
		const timeoutMs = this.options.shutdownTimeoutMs ?? 10_000;
		const deadline = Date.now() + timeoutMs;
		const errors: unknown[] = [];
		for (const record of [...this.instances].reverse()) {
			if (!record.started) {
				continue;
			}
			try {
				const remainingMs = Math.max(0, deadline - Date.now());
				await this.withTimeout(
					(signal) => record.instance.stop(signal),
					remainingMs,
					`Profile "${record.id}" shutdown timed out`,
				);
			} catch (error) {
				errors.push(error);
			}
		}
		try {
			await this.options.services.dispose();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length && this.fatalError === undefined) {
			this.fatalError = new AggregateError(errors, "Application shutdown failed");
		}
		this.currentState = this.fatalError === undefined ? "stopped" : "failed";
		const finalReason = this.fatalError === undefined ? reason : "failure";
		this.stopResult = this.result(finalReason);

		return this.stopResult;
	}

	private updateCompletion(): void {
		if (this.currentState !== "running") {
			return;
		}
		if (this.fatalError !== undefined) {
			this.resolveCompletion({ error: this.fatalError });

			return;
		}
		if (this.completedCount === this.instances.length) {
			this.resolveCompletion({});
		}
	}

	private resolveCompletion(value: Completion): void {
		this.complete(value);
	}

	private result(reason: StopReason): RunResult {
		const failed = reason === "failure" || this.fatalError !== undefined;

		return Object.freeze({
			status: failed ? "failed" : reason === "completed" ? "completed" : "stopped",
			exitCode: failed ? 1 : 0,
			reason: failed ? "failure" : reason,
			...(this.fatalError === undefined ? {} : { error: this.fatalError }),
		});
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
