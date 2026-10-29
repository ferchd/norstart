import type { ServiceContainer, ServiceResolver, ServiceToken } from "./contracts.ts";

type Factory<T> = (resolver: ServiceResolver) => T;
type Lifetime = "singleton" | "transient";

export class Container implements ServiceContainer {
	private readonly factories = new Map<
		ServiceToken<unknown>,
		{ factory: Factory<unknown>; lifetime: Lifetime }
	>();
	private readonly singletons = new Map<ServiceToken<unknown>, unknown>();
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
		this.assertActive();
		const registration = this.factories.get(token);
		if (!registration) {
			throw new Error(`Service is not registered: ${String(token)}`);
		}
		if (registration.lifetime === "singleton" && this.singletons.has(token)) {
			return this.singletons.get(token) as T;
		}
		const value = registration.factory(this);
		if (registration.lifetime === "singleton") {
			this.singletons.set(token, value);
		}

		return value as T;
	}

	createScope(): ServiceResolver {
		this.assertActive();
		const scoped = new Map<ServiceToken<unknown>, unknown>();

		return {
			get: <T>(token: ServiceToken<T>): T => {
				if (scoped.has(token)) {
					return scoped.get(token) as T;
				}
				const value = this.get(token);
				scoped.set(token, value);

				return value;
			},
		};
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		const values = [...this.singletons.values()].reverse();
		this.singletons.clear();
		const errors: unknown[] = [];
		for (const value of values) {
			if (
				value &&
				typeof value === "object" &&
				"dispose" in value &&
				typeof value.dispose === "function"
			) {
				try {
					await value.dispose();
				} catch (error) {
					errors.push(error);
				}
			}
		}
		if (errors.length) {
			throw new AggregateError(errors, "One or more singleton services failed to dispose");
		}
	}

	private assertActive(): void {
		if (this.disposed) {
			throw new Error("Service container has been disposed");
		}
	}
}
