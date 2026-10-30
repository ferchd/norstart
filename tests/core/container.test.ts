import { describe, expect, test } from "bun:test";
import { Container } from "../../src/core/container.ts";

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
