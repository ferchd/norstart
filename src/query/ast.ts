import type { SqlParameter } from "../sql/contracts.ts";

export interface Identifier {
	readonly kind: "identifier";
	readonly name: string;
}

export interface ColumnExpression {
	readonly kind: "column";
	readonly name: Identifier;
	readonly table?: Identifier;
}

export type SqlExpression = ColumnExpression | SqlParameter;
export type ComparisonOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

export interface ComparisonPredicate {
	readonly kind: "comparison";
	readonly operator: ComparisonOperator;
	readonly left: SqlExpression;
	readonly right: SqlExpression;
}

export interface LogicalPredicate {
	readonly kind: "and" | "or";
	readonly predicates: readonly SqlPredicate[];
}

export interface NullPredicate {
	readonly kind: "is-null" | "is-not-null";
	readonly expression: SqlExpression;
}

export type SqlPredicate = ComparisonPredicate | LogicalPredicate | NullPredicate;

export interface TableReference {
	readonly name: Identifier;
	readonly schema?: Identifier;
	readonly alias?: Identifier;
}

export interface Projection {
	readonly expression: SqlExpression;
	readonly alias?: Identifier;
}

export interface Ordering {
	readonly expression: SqlExpression;
	readonly direction: "asc" | "desc";
}

export interface SelectQueryOptions {
	readonly from: TableReference;
	readonly columns: readonly Projection[];
	readonly where?: SqlPredicate;
	readonly orderBy?: readonly Ordering[];
	readonly limit?: number;
	readonly offset?: number;
}

export interface SelectQuery extends SelectQueryOptions {
	readonly kind: "select";
}
