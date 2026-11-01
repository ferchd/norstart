import type { SqlParameter, SqlParameterType, SqlParameterValues } from "./contracts.ts";

export function parameter<T extends SqlParameterType>(
	type: T,
	value: NoInfer<SqlParameterValues[T]>,
): SqlParameter<T> {
	return snapshotParameter({ kind: "parameter", type, value }) as SqlParameter<T>;
}

export function snapshotParameter(input: unknown): SqlParameter {
	if (typeof input !== "object" || input === null) {
		throw new Error("SQL parameter must be an object");
	}
	const { kind, type, value } = input as Record<string, unknown>;
	if (kind !== "parameter") {
		throw new Error("Invalid SQL parameter kind");
	}
	let valid = false;
	switch (type) {
		case "text":
			valid = typeof value === "string";
			break;
		case "integer":
			valid = typeof value === "number" && Number.isSafeInteger(value);
			break;
		case "bigint":
			valid = typeof value === "bigint";
			break;
		case "decimal":
			valid = typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
			break;
		case "boolean":
			valid = typeof value === "boolean";
			break;
		case "timestamp":
			if (
				typeof value === "string" &&
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
			) {
				const date = new Date(value);
				valid = Number.isFinite(date.getTime()) && date.toISOString() === value;
			}
			break;
		case "null":
			valid = value === null;
			break;
		default:
			throw new Error("Unsupported SQL parameter type");
	}
	if (!valid) {
		throw new Error(`Invalid SQL parameter value for type ${type}`);
	}

	return Object.freeze({ kind: "parameter", type, value }) as SqlParameter;
}
