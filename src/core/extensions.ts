import type { ServiceContainer, ServiceResolver } from "./contracts.ts";
import type { Container } from "./container.ts";

export interface ExtensionShutdownContext {
	readonly services: ServiceResolver;
}

export interface ExtensionContext extends ExtensionShutdownContext {
	readonly signal: AbortSignal;
}

export interface ApplicationExtension {
	readonly name: string;
	readonly dependencies?: readonly string[];
	/** Register factories only. External resources belong in initialize(). */
	register?(services: Container): void;
	/** Honor cancellation and release partially initialized resources in shutdown(). */
	initialize?(context: ExtensionContext): void | Promise<void>;
	shutdown?(context: ExtensionShutdownContext): void | Promise<void>;
}

export class ExtensionManager {
	private readonly ordered: readonly ApplicationExtension[];
	private readonly entered: ApplicationExtension[] = [];
	private readonly abort = new AbortController();
	private pending?: Promise<void>;
	private shutdownPromise?: Promise<void>;

	constructor(
		extensions: readonly ApplicationExtension[],
		private readonly services: Container,
	) {
		this.ordered = orderExtensions(extensions);
	}

	register(): void {
		for (const extension of this.ordered) {
			const result: unknown = extension.register?.(this.services);
			if (
				result !== null &&
				(typeof result === "object" || typeof result === "function") &&
				"then" in result &&
				typeof result.then === "function"
			) {
				void Promise.resolve(result).catch(() => undefined);
				throw new Error(`Extension register must be synchronous: ${extension.name}`);
			}
		}
	}

	async initialize(signal: AbortSignal): Promise<void> {
		const combined = AbortSignal.any([signal, this.abort.signal]);
		const context = this.context(combined);
		for (const extension of this.ordered) {
			if (combined.aborted) {
				return;
			}

			const operation = Promise.resolve().then(async () => {
				if (combined.aborted) {
					return;
				}

				this.entered.push(extension);
				await extension.initialize?.(context);
			});
			this.pending = operation;
			const completed = await waitForInitialization(operation, combined);
			if (!completed) {
				return;
			}
			this.pending = undefined;
		}
	}

	container(): ServiceContainer {
		return {
			get: (token) => this.services.get(token),
			createScope: () => this.services.createScope(),
			dispose: () => this.shutdown(),
		};
	}

	private shutdown(): Promise<void> {
		if (!this.shutdownPromise) {
			this.abort.abort("shutdown");
			this.shutdownPromise = this.performShutdown();
		}

		return this.shutdownPromise;
	}

	private async performShutdown(): Promise<void> {
		const errors: unknown[] = [];
		// A cancelled initializer may settle after the Kernel's deadline. Clean it up then.
		await this.pending?.catch(() => undefined);
		const context = Object.freeze({ services: this.resolver() });
		for (const extension of [...this.entered].reverse()) {
			try {
				await extension.shutdown?.(context);
			} catch (error) {
				errors.push(error);
			}
		}
		try {
			await this.services.dispose();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, "Application extension and service shutdown failed");
		}
	}

	private context(signal: AbortSignal): ExtensionContext {
		return Object.freeze({
			services: this.resolver(),
			signal,
		});
	}

	private resolver(): ServiceResolver {
		return Object.freeze({ get: this.services.get.bind(this.services) });
	}
}

async function waitForInitialization(
	operation: Promise<void>,
	signal: AbortSignal,
): Promise<boolean> {
	let onAbort!: () => void;
	const cancelled = new Promise<false>((resolve) => {
		onAbort = () => resolve(false);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
		}
	});
	try {
		return await Promise.race([operation.then(() => true), cancelled]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function orderExtensions(
	extensions: readonly ApplicationExtension[],
): readonly ApplicationExtension[] {
	const byName = new Map<string, ApplicationExtension>();
	for (const extension of extensions) {
		if (!extension || typeof extension.name !== "string" || !extension.name.trim()) {
			throw new Error("Extension names must be non-empty strings");
		}
		if (byName.has(extension.name)) {
			throw new Error(`Duplicate extension: ${extension.name}`);
		}
		for (const hook of ["register", "initialize", "shutdown"] as const) {
			if (extension[hook] !== undefined && typeof extension[hook] !== "function") {
				throw new Error(`Invalid extension hook: ${extension.name}.${hook}`);
			}
		}
		if (
			extension.dependencies !== undefined &&
			(!Array.isArray(extension.dependencies) ||
				!extension.dependencies.every((name) => typeof name === "string" && name.trim()))
		) {
			throw new Error(`Invalid extension dependencies: ${extension.name}`);
		}
		byName.set(
			extension.name,
			Object.freeze({
				name: extension.name,
				dependencies: Object.freeze([...(extension.dependencies ?? [])]),
				register: extension.register?.bind(extension),
				initialize: extension.initialize?.bind(extension),
				shutdown: extension.shutdown?.bind(extension),
			}),
		);
	}
	const ordered: ApplicationExtension[] = [];
	const visited = new Set<string>();
	const visit = (name: string, path: readonly string[]): void => {
		if (path.includes(name)) {
			throw new Error(`Circular extension dependency: ${[...path, name].join(" -> ")}`);
		}
		if (visited.has(name)) {
			return;
		}
		const extension = byName.get(name);
		if (!extension) {
			throw new Error(`Missing extension dependency: ${name}`);
		}
		for (const dependency of extension.dependencies ?? []) {
			visit(dependency, [...path, name]);
		}
		visited.add(name);
		ordered.push(extension);
	};
	for (const name of byName.keys()) {
		visit(name, []);
	}

	return ordered;
}
