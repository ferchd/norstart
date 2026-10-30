import { describe, expect, test } from "bun:test";
import { CircularDependencyError, Container } from "../../src/core/container.ts";

describe("Container", () => {
	test("creates transient instances and reuses singleton instances", () => {
		const container = new Container();
		const transient = Symbol("transient");
		const singleton = Symbol("singleton");
		let transientCreations = 0;
		let singletonCreations = 0;

		container.register(transient, () => ({ id: ++transientCreations }));
		container.register(singleton, () => ({ id: ++singletonCreations }), "singleton");

		expect(container.get(transient)).not.toBe(container.get(transient));
		expect(container.get(singleton)).toBe(container.get(singleton));
		expect(transientCreations).toBe(2);
		expect(singletonCreations).toBe(1);
	});

	test("resolves transient values again within the same resolver scope", () => {
		const container = new Container();
		const token = Symbol("scoped transient");
		let creations = 0;
		container.register(token, () => ({ id: ++creations }));

		const firstScope = container.createScope();
		const secondScope = container.createScope();
		const firstResolution = firstScope.get(token);
		const secondResolution = firstScope.get(token);
		const thirdResolution = secondScope.get(token);

		expect(firstResolution).not.toBe(secondResolution);
		expect(thirdResolution).not.toBe(secondResolution);
		expect(creations).toBe(3);
	});

	test("reuses scoped services per scope and disposes them once in reverse order", async () => {
		const container = new Container();
		const events: string[] = [];
		const first = Symbol("first scoped service");
		const second = Symbol("second scoped service");
		let firstCreations = 0;
		let secondCreations = 0;
		container.register(
			first,
			() => {
				const id = ++firstCreations;

				return {
					id,
					dispose: () => {
						events.push(`first:${id}`);
					},
				};
			},
			"scoped",
		);
		container.register(
			second,
			() => {
				const id = ++secondCreations;

				return {
					id,
					dispose: () => {
						events.push(`second:${id}`);
					},
				};
			},
			"scoped",
		);
		const firstScope = container.createScope();
		const secondScope = container.createScope();
		const firstScopeFirst = firstScope.get(first);
		const firstScopeSecond = firstScope.get(second);
		const secondScopeFirst = secondScope.get(first);
		const secondScopeSecond = secondScope.get(second);

		expect(firstScope.get(first)).toBe(firstScopeFirst);
		expect(firstScope.get(second)).toBe(firstScopeSecond);
		expect(secondScopeFirst).not.toBe(firstScopeFirst);
		expect(secondScopeSecond).not.toBe(firstScopeSecond);

		await firstScope.dispose();
		await firstScope.dispose();

		expect(events).toEqual(["second:1", "first:1"]);
		expect(() => firstScope.get(first)).toThrow("disposed");

		await secondScope.dispose();

		expect(events).toEqual(["second:1", "first:1", "second:2", "first:2"]);
		await container.dispose();
		expect(events).toEqual(["second:1", "first:1", "second:2", "first:2"]);
	});

	test("shares singleton services across scopes and disposes them with the container", async () => {
		const container = new Container();
		const events: string[] = [];
		const singleton = Symbol("singleton");
		container.register(
			singleton,
			() => ({
				dispose: () => {
					events.push("dispose:singleton");
				},
			}),
			"singleton",
		);
		const firstScope = container.createScope();
		const secondScope = container.createScope();
		const firstResolution = firstScope.get(singleton);

		expect(secondScope.get(singleton)).toBe(firstResolution);
		expect(container.get(singleton)).toBe(firstResolution);

		await firstScope.dispose();
		await secondScope.dispose();
		expect(events).toEqual([]);

		await container.dispose();
		expect(events).toEqual(["dispose:singleton"]);
	});

	test("disposes active scopes before container singletons", async () => {
		const container = new Container();
		const events: string[] = [];
		const scoped = Symbol("active scoped service");
		const singleton = Symbol("container singleton");
		container.register(
			scoped,
			() => ({
				dispose: () => {
					events.push("dispose:scoped");
				},
			}),
			"scoped",
		);
		container.register(
			singleton,
			() => ({
				dispose: () => {
					events.push("dispose:singleton");
				},
			}),
			"singleton",
		);
		const scope = container.createScope();
		scope.get(scoped);
		container.get(singleton);

		await container.dispose();

		expect(events).toEqual(["dispose:scoped", "dispose:singleton"]);
		await scope.dispose();
		expect(events).toEqual(["dispose:scoped", "dispose:singleton"]);
		expect(() => scope.get(scoped)).toThrow("disposed");
	});

	test("waits for an active scope disposal before disposing container singletons", async () => {
		const container = new Container();
		const events: string[] = [];
		let finishScopeDisposal!: () => void;
		let signalScopeDisposal!: () => void;
		const scopeDisposalEntered = new Promise<void>((resolve) => {
			signalScopeDisposal = resolve;
		});
		const scopeDisposalGate = new Promise<void>((resolve) => {
			finishScopeDisposal = resolve;
		});
		const scoped = Symbol("gated scoped service");
		const singleton = Symbol("singleton waiting on scope");
		container.register(
			scoped,
			() => ({
				dispose: async () => {
					events.push("scope:started");
					signalScopeDisposal();
					await scopeDisposalGate;
					events.push("scope:finished");
				},
			}),
			"scoped",
		);
		container.register(
			singleton,
			() => ({
				dispose: () => {
					events.push("singleton");
				},
			}),
			"singleton",
		);
		const scope = container.createScope();
		scope.get(scoped);
		container.get(singleton);

		const explicitScopeDisposal = scope.dispose();
		await scopeDisposalEntered;
		const containerDisposal = container.dispose();
		await Promise.resolve();

		expect(events).toEqual(["scope:started"]);

		finishScopeDisposal();
		await Promise.all([explicitScopeDisposal, containerDisposal]);

		expect(events).toEqual(["scope:started", "scope:finished", "singleton"]);
	});

	test("rejects singleton dependencies on scoped services through transient services", async () => {
		const container = new Container();
		const scoped = Symbol("scoped dependency");
		const transient = Symbol("transient dependency");
		const singleton = Symbol("singleton consumer");
		container.register(scoped, () => ({}), "scoped");
		container.register(transient, (resolver) => resolver.get(scoped));
		container.register(singleton, (resolver) => resolver.get(transient), "singleton");

		expect(() => container.get(singleton)).toThrow(
			"Singleton services cannot depend on scoped services",
		);

		await container.dispose();
	});

	test("rejects scoped services from the root and resolves them within explicit scopes", async () => {
		const container = new Container();
		const events: string[] = [];
		const scoped = Symbol("scoped service");
		let creations = 0;
		container.register(
			scoped,
			() => {
				const id = ++creations;

				return {
					id,
					dispose: () => {
						events.push(`dispose:${id}`);
					},
				};
			},
			"scoped",
		);

		expect(() => container.get(scoped)).toThrow(
			"Scoped services must be resolved from a service scope",
		);
		expect(creations).toBe(0);

		const firstScope = container.createScope();
		const secondScope = container.createScope();
		const first = firstScope.get(scoped);

		expect(firstScope.get(scoped)).toBe(first);
		expect(secondScope.get(scoped)).not.toBe(first);
		expect(creations).toBe(2);

		await firstScope.dispose();
		await secondScope.dispose();
		await container.dispose();

		expect(events).toEqual(["dispose:1", "dispose:2"]);
	});

	test("reports the complete path for a transitive circular dependency", () => {
		const container = new Container();
		const first = Symbol("A");
		const second = Symbol("B");
		const third = Symbol("C");
		container.register(first, (resolver) => resolver.get(second));
		container.register(second, (resolver) => resolver.get(third));
		container.register(third, (resolver) => resolver.get(first));

		let cycleError: unknown;
		try {
			container.get(first);
		} catch (error) {
			cycleError = error;
		}

		expect(cycleError).toBeInstanceOf(CircularDependencyError);
		expect(cycleError).toMatchObject({
			message: "Circular dependency detected: A -> B -> C -> A",
			path: ["A", "B", "C", "A"],
		});

		const healthy = Symbol("healthy after cycle");
		container.register(healthy, () => "healthy");
		expect(container.get(healthy)).toBe("healthy");
	});

	test("rejects scoped services reached from the root through a transient", () => {
		const container = new Container();
		const scoped = Symbol("scoped root dependency");
		const transient = Symbol("transient root consumer");
		container.register(scoped, () => ({}), "scoped");
		container.register(transient, (resolver) => resolver.get(scoped));

		expect(() => container.get(transient)).toThrow(
			"Scoped services must be resolved from a service scope",
		);
	});

	test("rejects duplicate and missing registrations", () => {
		const container = new Container();
		const token = Symbol("service");
		container.register(token, () => "service");

		expect(() => container.register(token, () => "duplicate")).toThrow("already registered");
		expect(() => container.get(Symbol("missing"))).toThrow("not registered");
	});

	test("disposes singleton services once in reverse creation order", async () => {
		const container = new Container();
		const events: string[] = [];
		const first = Symbol("first");
		const second = Symbol("second");
		container.register(first, () => ({ dispose: () => events.push("first") }), "singleton");
		container.register(second, () => ({ dispose: () => events.push("second") }), "singleton");
		container.get(first);
		container.get(second);

		await container.dispose();
		await container.dispose();

		expect(events).toEqual(["second", "first"]);
		expect(() => container.get(first)).toThrow("disposed");
		expect(() => container.createScope()).toThrow("disposed");
		expect(() => container.register(Symbol("late"), () => undefined)).toThrow("disposed");
	});

	test("continues disposing after an error and rejects with an aggregate", async () => {
		const container = new Container();
		const events: string[] = [];
		const broken = Symbol("broken");
		const healthy = Symbol("healthy");
		container.register(
			broken,
			() => ({
				dispose: () => {
					events.push("broken");
					throw new Error("dispose failed");
				},
			}),
			"singleton",
		);
		container.register(healthy, () => ({ dispose: () => events.push("healthy") }), "singleton");
		container.get(broken);
		container.get(healthy);

		await expect(container.dispose()).rejects.toBeInstanceOf(AggregateError);
		expect(events).toEqual(["healthy", "broken"]);
		await expect(container.dispose()).resolves.toBeUndefined();
	});
});
