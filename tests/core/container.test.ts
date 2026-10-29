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

	test("caches transient values once per resolver scope", () => {
		const container = new Container();
		const token = Symbol("scoped transient");
		let creations = 0;
		container.register(token, () => ({ id: ++creations }));

		const firstScope = container.createScope();
		const secondScope = container.createScope();
		expect(firstScope.get(token)).toBe(firstScope.get(token));
		expect(secondScope.get(token)).not.toBe(firstScope.get(token));
		expect(creations).toBe(2);
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
