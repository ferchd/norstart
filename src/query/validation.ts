import { snapshotParameter } from "../sql/parameters.ts";
import type { Identifier, Ordering, SelectQuery, SqlExpression, SqlPredicate } from "./ast.ts";

interface Traversal {
	readonly active: Set<object>;
	nodes: number;
}

function record(input: unknown, label: string): Record<string, unknown> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error(`Invalid SQL ${label}`);
	}

	return input as Record<string, unknown>;
}

function keys(input: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(input).some((key) => !allowed.includes(key))) {
		throw new Error("Unsupported SQL AST property");
	}
}

function snapshotArray<T>(
	input: unknown,
	minimumLength: number,
	snapshot: (entry: unknown) => T,
): T[] {
	if (!Array.isArray(input)) {
		throw new Error("Invalid SQL AST array");
	}
	const length: unknown = input.length;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < minimumLength ||
		length > 10000
	) {
		throw new Error("SQL AST array length is outside its complexity limit");
	}

	return Array.from({ length }, (_, index) => snapshot(input[index]));
}

export function snapshotIdentifier(input: unknown): Identifier {
	const value = record(input, "identifier");
	keys(value, ["kind", "name"]);
	const { kind, name } = value;
	if (
		kind !== "identifier" ||
		typeof name !== "string" ||
		!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
	) {
		throw new Error("SQL identifiers must be non-empty ASCII names without qualification");
	}

	return Object.freeze({ kind: "identifier", name });
}

export function snapshotExpression(input: unknown): SqlExpression {
	const value = record(input, "expression");
	if (value.kind === "parameter") {
		keys(value, ["kind", "type", "value"]);

		return snapshotParameter(value);
	}
	if (value.kind !== "column") {
		throw new Error("Unsupported SQL expression kind");
	}
	keys(value, ["kind", "name", "table"]);

	return Object.freeze({
		kind: "column",
		name: snapshotIdentifier(value.name),
		table: value.table === undefined ? undefined : snapshotIdentifier(value.table),
	});
}

export function snapshotPredicate(
	input: unknown,
	traversal: Traversal = { active: new Set(), nodes: 0 },
): SqlPredicate {
	const value = record(input, "predicate");
	if (traversal.active.has(value)) {
		throw new Error("Cyclic SQL AST is unsupported");
	}
	if (traversal.active.size >= 100 || ++traversal.nodes > 10000) {
		throw new Error("SQL AST exceeds its complexity limit");
	}
	traversal.active.add(value);
	try {
		const kind = value.kind;
		if (kind === "comparison") {
			keys(value, ["kind", "operator", "left", "right"]);
			const operator = value.operator;
			if (
				operator !== "eq" &&
				operator !== "ne" &&
				operator !== "gt" &&
				operator !== "gte" &&
				operator !== "lt" &&
				operator !== "lte"
			) {
				throw new Error("Unsupported SQL comparison operator");
			}
			const left = snapshotExpression(value.left);
			const right = snapshotExpression(value.right);
			const hasNull = [left, right].some(
				(expression) => expression.kind === "parameter" && expression.type === "null",
			);
			if (hasNull && operator !== "eq" && operator !== "ne") {
				throw new Error("SQL NULL supports only equality and inequality comparisons");
			}

			return Object.freeze({ kind: "comparison", operator, left, right });
		}
		if (kind === "and" || kind === "or") {
			keys(value, ["kind", "predicates"]);
			const predicates = value.predicates;

			return Object.freeze({
				kind,
				predicates: Object.freeze(
					snapshotArray(predicates, 1, (entry) => snapshotPredicate(entry, traversal)),
				),
			});
		}
		if (kind === "is-null" || kind === "is-not-null") {
			keys(value, ["kind", "expression"]);

			return Object.freeze({
				kind,
				expression: snapshotExpression(value.expression),
			});
		}

		throw new Error("Unsupported SQL predicate kind");
	} finally {
		traversal.active.delete(value);
	}
}

function pagination(input: unknown): number | undefined {
	if (input === undefined) {
		return undefined;
	}
	if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
		throw new Error("SQL pagination must be a non-negative safe integer");
	}

	return input;
}

function snapshotOrdering(input: unknown): Ordering {
	const ordering = record(input, "ordering");
	keys(ordering, ["expression", "direction"]);
	const direction = ordering.direction;
	if (direction !== "asc" && direction !== "desc") {
		throw new Error("Unsupported SQL ordering direction");
	}

	return Object.freeze({ expression: snapshotExpression(ordering.expression), direction });
}

export function snapshotQuery(input: unknown): SelectQuery {
	const value = record(input, "query");
	keys(value, ["kind", "from", "columns", "where", "orderBy", "limit", "offset"]);
	const { kind, columns: projectionEntries, orderBy: orderingEntries } = value;
	if (kind !== "select") {
		throw new Error("Unsupported SQL query kind");
	}
	const from = record(value.from, "table reference");
	keys(from, ["name", "schema", "alias"]);
	const columns = snapshotArray(projectionEntries, 1, (input) => {
		const projection = record(input, "projection");
		keys(projection, ["expression", "alias"]);

		return Object.freeze({
			expression: snapshotExpression(projection.expression),
			alias:
				projection.alias === undefined ? undefined : snapshotIdentifier(projection.alias),
		});
	});
	const orderBy =
		orderingEntries === undefined
			? undefined
			: snapshotArray(orderingEntries, 0, snapshotOrdering);
	const limit = pagination(value.limit);
	const offset = pagination(value.offset);
	if (offset !== undefined && limit === undefined) {
		throw new Error("SQL OFFSET requires LIMIT in the portable SELECT contract");
	}

	return Object.freeze({
		kind: "select",
		from: Object.freeze({
			name: snapshotIdentifier(from.name),
			schema: from.schema === undefined ? undefined : snapshotIdentifier(from.schema),
			alias: from.alias === undefined ? undefined : snapshotIdentifier(from.alias),
		}),
		columns: Object.freeze(columns),
		where: value.where === undefined ? undefined : snapshotPredicate(value.where),
		orderBy: orderBy === undefined ? undefined : Object.freeze(orderBy),
		limit,
		offset,
	});
}
