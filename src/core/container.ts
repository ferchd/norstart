import type {
	ServiceContainer,
	ServiceLifetime,
	ServiceResolver,
	ServiceScope,
	ServiceToken,
} from "./contracts.ts";

type Factory<T> = (resolver: ServiceResolver) => T;
type Registration = { factory: Factory<unknown>; lifetime: ServiceLifetime };
type Disposable = { dispose(): void | Promise<void> };

export class CircularDependencyError extends Error {
	constructor(readonly path: readonly string[]) {
		super(`Circular dependency detected: ${path.join(" -> ")}`);
		this.name = "CircularDependencyError";
	}
}

export class Container implements ServiceContainer {
	private readonly factories = new Map<ServiceToken<unknown>, Registration>();
	private readonly singletons = new Map<ServiceToken<unknown>, unknown>();
	private readonly activeScopes = new Set<ServiceScope>();
	private readonly disposables: unknown[] = [];
	private readonly resolutionPath: ServiceToken<unknown>[] = [];
	private singletonResolutionDepth = 0;
	private disposed = false;
	private disposePromise?: Promise<void>;

	register<T>(
		token: ServiceToken<T>,
		factory: Factory<T>,
		lifetime: ServiceLifetime = "transient",
	): this {
		this.assertActive();

		if (this.factories.has(token)) {
			throw new Error(`Service is already registered: ${String(token)}`);
		}

		this.factories.set(token, { factory, lifetime });

		return this;
	}

	get<T>(token: ServiceToken<T>): T {
		return this.resolve(token, this, new Map(), this.disposables);
	}

	createScope(): ServiceScope {
		this.assertActive();
		const scoped = new Map<ServiceToken<unknown>, unknown>();
		const disposables: unknown[] = [];
		let scopeDisposed = false;
		let scopeDisposePromise: Promise<void> | undefined;
		const resolver: ServiceResolver = {
			get: <T>(token: ServiceToken<T>): T => {
				if (scopeDisposed) {
					throw new Error("Service scope has been disposed");
				}

				return this.resolve(token, resolver, scoped, disposables);
			},
		};
		const scope: ServiceScope = {
			get: resolver.get,
			dispose: (): Promise<void> => {
				if (scopeDisposePromise) {
					return scopeDisposePromise;
				}

				scopeDisposed = true;
				scopeDisposePromise = this.disposeValues(
					disposables,
					"One or more scoped services failed to dispose",
				).finally(() => {
					this.activeScopes.delete(scope);
				});

				return scopeDisposePromise;
			},
		};
		this.activeScopes.add(scope);

		return scope;
	}

	dispose(): Promise<void> {
		if (this.disposePromise) {
			return this.disposePromise;
		}

		if (this.disposed) {
			return Promise.resolve();
		}

		this.disposed = true;
		this.disposePromise = this.disposeServices().catch((error: unknown) => {
			this.disposePromise = undefined;

			throw error;
		});

		return this.disposePromise;
	}

	private async disposeServices(): Promise<void> {
		this.singletons.clear();
		const errors: unknown[] = [];

		for (const scope of [...this.activeScopes].reverse()) {
			try {
				await scope.dispose();
			} catch (error) {
				errors.push(error);
			}
		}

		this.activeScopes.clear();

		try {
			await this.disposeValues(this.disposables, "One or more services failed to dispose");
		} catch (error) {
			errors.push(error);
		}

		if (errors.length > 0) {
			throw new AggregateError(errors, "One or more container services failed to dispose");
		}
	}

	private resolve<T>(
		token: ServiceToken<T>,
		resolver: ServiceResolver,
		scoped: Map<ServiceToken<unknown>, unknown>,
		disposables: unknown[],
	): T {
		this.assertActive();
		const registration = this.factories.get(token);

		if (!registration) {
			throw new Error(`Service is not registered: ${String(token)}`);
		}
		if (registration.lifetime === "scoped" && this.singletonResolutionDepth > 0) {
			throw new Error("Singleton services cannot depend on scoped services");
		}
		if (registration.lifetime === "scoped" && resolver === this) {
			throw new Error("Scoped services must be resolved from a service scope");
		}

		const cycleStart = this.resolutionPath.indexOf(token);
		if (cycleStart !== -1) {
			const path = [...this.resolutionPath.slice(cycleStart), token].map((entry) =>
				this.describeToken(entry),
			);

			throw new CircularDependencyError(path);
		}

		this.resolutionPath.push(token);
		try {
			return this.resolveRegistered(token, registration, resolver, scoped, disposables);
		} finally {
			this.resolutionPath.pop();
		}
	}

	private resolveRegistered<T>(
		token: ServiceToken<T>,
		registration: Registration,
		resolver: ServiceResolver,
		scoped: Map<ServiceToken<unknown>, unknown>,
		disposables: unknown[],
	): T {
		if (registration.lifetime === "singleton" && this.singletons.has(token)) {
			return this.singletons.get(token) as T;
		}

		if (registration.lifetime === "scoped" && scoped.has(token)) {
			return scoped.get(token) as T;
		}

		let value: unknown;
		if (registration.lifetime === "singleton") {
			this.singletonResolutionDepth++;
			try {
				value = registration.factory(this);
			} finally {
				this.singletonResolutionDepth--;
			}
		} else {
			value = registration.factory(resolver);
		}

		if (registration.lifetime === "singleton") {
			this.singletons.set(token, value);
			this.disposables.push(value);
		} else if (registration.lifetime === "scoped") {
			scoped.set(token, value);
			disposables.push(value);
		}

		return value as T;
	}

	private describeToken(token: ServiceToken<unknown>): string {
		if (typeof token === "symbol") {
			return token.description ?? token.toString();
		}

		return token.name || "<anonymous service>";
	}

	private async disposeValues(values: unknown[], message: string): Promise<void> {
		const errors: unknown[] = [];

		for (const value of values.splice(0).reverse()) {
			if (!this.isDisposable(value)) {
				continue;
			}

			try {
				await value.dispose();
			} catch (error) {
				errors.push(error);
			}
		}

		if (errors.length > 0) {
			throw new AggregateError(errors, message);
		}
	}

	private isDisposable(value: unknown): value is Disposable {
		return (
			value !== null &&
			typeof value === "object" &&
			"dispose" in value &&
			typeof value.dispose === "function"
		);
	}

	private assertActive(): void {
		if (this.disposed) {
			throw new Error("Service container has been disposed");
		}
	}
}
