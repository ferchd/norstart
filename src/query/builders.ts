import type {
	ColumnExpression,
	ComparisonOperator,
	Identifier,
	SelectQuery,
	SelectQueryOptions,
	SqlExpression,
	SqlPredicate,
} from "./ast.ts";
import { snapshotIdentifier, snapshotPredicate, snapshotQuery } from "./validation.ts";

export function identifier(name: string): Identifier {
	return snapshotIdentifier({ kind: "identifier", name });
}

export function column(name: Identifier | string, table?: Identifier | string): ColumnExpression {
	return Object.freeze({
		kind: "column",
		name: typeof name === "string" ? identifier(name) : snapshotIdentifier(name),
		table:
			typeof table === "string"
				? identifier(table)
				: table === undefined
					? undefined
					: snapshotIdentifier(table),
	});
}

export function compare(
	operator: ComparisonOperator,
	left: SqlExpression,
	right: SqlExpression,
): SqlPredicate {
	return snapshotPredicate({ kind: "comparison", operator, left, right });
}

export function and(...predicates: readonly SqlPredicate[]): SqlPredicate {
	return snapshotPredicate({ kind: "and", predicates });
}

export function or(...predicates: readonly SqlPredicate[]): SqlPredicate {
	return snapshotPredicate({ kind: "or", predicates });
}

export function isNull(expression: SqlExpression): SqlPredicate {
	return snapshotPredicate({ kind: "is-null", expression });
}

export function isNotNull(expression: SqlExpression): SqlPredicate {
	return snapshotPredicate({ kind: "is-not-null", expression });
}

export function selectQuery(options: SelectQueryOptions): SelectQuery {
	return snapshotQuery({ ...options, kind: "select" });
}
