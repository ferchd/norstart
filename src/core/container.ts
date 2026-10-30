import type { ServiceContainer, ServiceResolver, ServiceScope, ServiceToken } from "./contracts.ts";

type Factory<T> = (resolver: ServiceResolver) => T;
type Lifetime = "singleton" | "transient" | "scoped";
type Registration = { factory: Factory<unknown>; lifetime: Lifetime };
type Disposable = { dispose(): void | Promise<void> };

export class Container implements ServiceContainer {
	private readonly factories = new Map<ServiceToken<unknown>, Registration>();
	private readonly singletons = new Map<ServiceToken<unknown>, unknown>();
	private readonly rootScoped = new Map<ServiceToken<unknown>, unknown>();
	private readonly disposables: unknown[] = [];
	private disposed = false;

	register<T>(
		token: ServiceToken<T>,
		factory: Factory<T>,
		lifetime: Lifetime = "transient",
	): this {
		this.assertActive();

		if (this.factories.has(token)) {
			throw new Error(`Service is already registered: ${String(token)}`);
		}

		this.factories.set(token, { factory, lifetime });

		return this;
	}

	get<T>(token: ServiceToken<T>): T {
		return this.resolve(token, this, this.rootScoped, this.disposables);
	}

	createScope(): ServiceScope {
		this.assertActive();
		const scoped = new Map<ServiceToken<unknown>, unknown>();
		const disposables: unknown[] = [];
		let scopeDisposed = false;
		const scope: ServiceResolver = {
			get: <T>(token: ServiceToken<T>): T => {
				if (scopeDisposed) {
					throw new Error("Service scope has been disposed");
				}

				return this.resolve(token, scope, scoped, disposables);
			},
		};

		return {
			get: scope.get,
			dispose: async (): Promise<void> => {
				if (scopeDisposed) {
					return;
				}

				scopeDisposed = true;
				await this.disposeValues(
					disposables,
					"One or more scoped services failed to dispose",
				);
			},
		};
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		this.singletons.clear();
		this.rootScoped.clear();
		await this.disposeValues(this.disposables, "One or more services failed to dispose");
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

		if (registration.lifetime === "singleton" && this.singletons.has(token)) {
			return this.singletons.get(token) as T;
		}

		if (registration.lifetime === "scoped" && scoped.has(token)) {
			return scoped.get(token) as T;
		}

		const factoryResolver = registration.lifetime === "singleton" ? this : resolver;
		const value = registration.factory(factoryResolver);

		if (registration.lifetime === "singleton") {
			this.singletons.set(token, value);
			this.disposables.push(value);
		} else if (registration.lifetime === "scoped") {
			scoped.set(token, value);
			disposables.push(value);
		}

		return value as T;
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
