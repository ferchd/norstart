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
	private stopPromise?: Promise<RunResult>;
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
		try {
			for (const definition of this.options.manifest.profiles) {
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
						this.updateCompletion();
					},
					(error: unknown) => {
						record.settled = true;
						this.completedCount++;
						this.resolveCompletion({ error });
					},
				);
			}
			this.currentState = "ready";
		} catch (error) {
			this.fatalError = error;
			this.currentState = "failed";
			throw error;
		}
	}

	async start(): Promise<void> {
		if (this.currentState !== "ready") {
			throw new Error(`Cannot start Kernel in state "${this.currentState}"`);
		}
		this.currentState = "starting";
		try {
			for (const record of this.instances) {
				record.started = true;
				await record.instance.start(this.runAbort.signal);
			}
			this.currentState = "running";
			this.updateCompletion();
		} catch (error) {
			this.fatalError = error;
			await this.stop("failure");
			this.currentState = "failed";
			throw error;
		}
	}

	async waitForExit(): Promise<RunResult> {
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
		this.resolveCompletion({});
		if (this.stopPromise) {
			return this.stopPromise;
		}
		if (this.currentState === "stopped" || this.currentState === "failed") {
			return Promise.resolve(this.stopResult ?? this.result(reason));
		}
		this.stopPromise = this.performStop(reason);

		return this.stopPromise;
	}

	private async performStop(reason: StopReason): Promise<RunResult> {
		this.currentState = "stopping";
		this.bootstrapAbort.abort(reason);
		this.runAbort.abort(reason);
		const timeoutMs = this.options.shutdownTimeoutMs ?? 10_000;
		const errors: unknown[] = [];
		for (const record of [...this.instances].reverse()) {
			if (!record.started) {
				continue;
			}
			try {
				await this.withTimeout(
					(signal) => record.instance.stop(signal),
					timeoutMs,
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
