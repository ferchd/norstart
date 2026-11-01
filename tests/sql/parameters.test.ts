import { expect, test } from "bun:test";
import { parameter } from "../../src/sql/index.ts";

test("captures typed SQL parameters as immutable primitive metadata", () => {
	const values = [
		parameter("text", "O'Reilly"),
		parameter("integer", 42),
		parameter("bigint", 9007199254740993n),
		parameter("decimal", "-12.50"),
		parameter("boolean", true),
		parameter("timestamp", "2026-11-01T00:00:00.000Z"),
		parameter("null", null),
	];

	expect(values.map(({ type, value }) => ({ type, value }))).toEqual([
		{ type: "text", value: "O'Reilly" },
		{ type: "integer", value: 42 },
		{ type: "bigint", value: 9007199254740993n },
		{ type: "decimal", value: "-12.50" },
		{ type: "boolean", value: true },
		{ type: "timestamp", value: "2026-11-01T00:00:00.000Z" },
		{ type: "null", value: null },
	]);
	for (const value of values) {
		expect(Object.isFrozen(value)).toBe(true);
	}
});

test.each([
	["integer", 1.5],
	["integer", Number.NaN],
	["integer", Number.POSITIVE_INFINITY],
	["integer", Number.MAX_SAFE_INTEGER + 1],
	["decimal", "1; DROP TABLE users"],
	["decimal", "NaN"],
	["decimal", "Infinity"],
	["decimal", ""],
	["decimal", "01"],
	["decimal", "1e3"],
	["decimal", "+1"],
	["decimal", " 1 "],
	["timestamp", "2026-02-30T00:00:00.000Z"],
	["timestamp", "not a date"],
	["timestamp", "2026-11-01"],
	["timestamp", "2026-11-01T00:00:00+00:00"],
	["boolean", "true"],
	["bigint", 1],
	["text", { toString: () => "text" }],
	["null", "null"],
	["raw", "now()"],
] as const)("rejects malformed %s parameter values", (type, value) => {
	const untypedParameter = parameter as (type: unknown, value: unknown) => unknown;
	expect(() => untypedParameter(type, value)).toThrow();
});

test("parameter types reject incompatible values at the TypeScript boundary", () => {
	expect(() => {
		// @ts-expect-error Integer parameters require numbers, not numeric text.
		parameter("integer", "42");
	}).toThrow();
	expect(() => {
		// @ts-expect-error Boolean parameters require booleans.
		parameter("boolean", 1);
	}).toThrow();
});
