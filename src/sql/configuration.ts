import type { SqlClientOptions } from "./client.ts";
import type { SqlDialect } from "./contracts.ts";

function optionalNumber(value: unknown): number | undefined {
	if (value !== undefined && typeof value !== "number") {
		throw new Error("SQL numeric configuration fields must be numbers");
	}

	return value;
}

export function sqlOptionsFromConfiguration(
	input: unknown,
	environment: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<SqlClientOptions> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error("SQL configuration must be a table");
	}
	const fields = input as Record<string, unknown>;
	const allowed = [
		"dialect",
		"url",
		"urlEnvironment",
		"maxConnections",
		"connectionTimeoutSeconds",
		"closeTimeoutSeconds",
	];
	if (Object.keys(fields).some((key) => !allowed.includes(key))) {
		throw new Error("Unknown SQL configuration field");
	}
	const { dialect, urlEnvironment } = fields;
	const dialects: readonly unknown[] = ["postgresql", "mysql", "mariadb", "sqlite"];
	if (!dialects.includes(dialect)) {
		throw new Error("Unsupported SQL configuration dialect");
	}
	if (
		urlEnvironment !== undefined &&
		(typeof urlEnvironment !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(urlEnvironment))
	) {
		throw new Error("SQL urlEnvironment must name an environment variable");
	}
	const configuredUrl = fields.url;
	if (configuredUrl !== undefined && typeof configuredUrl !== "string") {
		throw new Error("SQL URL configuration must be a string");
	}
	const override = typeof urlEnvironment === "string" ? environment[urlEnvironment] : undefined;
	const url = override === undefined ? configuredUrl : override;
	if (typeof url !== "string" || !url.trim()) {
		throw new Error("SQL URL configuration is missing or empty");
	}

	return Object.freeze({
		dialect: dialect as SqlDialect,
		url,
		maxConnections: optionalNumber(fields.maxConnections),
		connectionTimeoutSeconds: optionalNumber(fields.connectionTimeoutSeconds),
		closeTimeoutSeconds: optionalNumber(fields.closeTimeoutSeconds),
	});
}
