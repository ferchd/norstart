import { expect, test } from "bun:test";
import { sqlOptionsFromConfiguration } from "../../src/sql/configuration.ts";

test("SQL configuration snapshots TOML values and resolves an explicit environment override", () => {
	const parsed = Bun.TOML.parse(`
[sql]
dialect = "sqlite"
url = ":memory:"
urlEnvironment = "SQL_URL"
maxConnections = 1
`) as { sql: unknown };
	const table = parsed.sql;
	const fallback = sqlOptionsFromConfiguration(table, {});
	const overridden = sqlOptionsFromConfiguration(table, { SQL_URL: "sqlite://app.db" });

	expect(fallback.url).toBe(":memory:");
	expect(overridden.url).toBe("sqlite://app.db");
	expect(overridden.maxConnections).toBe(1);
	expect(Object.isFrozen(overridden)).toBe(true);
});

test.each(
	[
		null,
		[],
		{ dialect: "sqlite", url: ":memory:", typo: 1 },
		{ dialect: "unsupported", url: ":memory:" },
		{ dialect: "sqlite", url: 2 },
		{ dialect: "sqlite", urlEnvironment: "bad-name" },
		{ dialect: "sqlite", maxConnections: "2", url: ":memory:" },
		{ dialect: "sqlite" },
	].map((input) => ({ input })),
)("rejects invalid SQL configuration without logging connection values", ({ input }) => {
	expect(() => sqlOptionsFromConfiguration(input, {})).toThrow();
});

test("an empty explicit environment override fails instead of silently using a fallback", () => {
	expect(() =>
		sqlOptionsFromConfiguration(
			{ dialect: "sqlite", url: ":memory:", urlEnvironment: "SQL_URL" },
			{ SQL_URL: "" },
		),
	).toThrow("missing or empty");
});
