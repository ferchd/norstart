import type { CompiledQuery, SqlDialect, SqlParameter } from "../sql/contracts.ts";
import { parameter } from "../sql/parameters.ts";
import type { Identifier, SelectQuery, SqlExpression, SqlPredicate } from "./ast.ts";
import { snapshotQuery } from "./validation.ts";

export function compileQuery(query: SelectQuery, dialect: SqlDialect): CompiledQuery {
	if (
		dialect !== "postgresql" &&
		dialect !== "mysql" &&
		dialect !== "mariadb" &&
		dialect !== "sqlite"
	) {
		throw new Error("Unsupported SQL dialect");
	}
	const ast = snapshotQuery(query);
	const params: SqlParameter[] = [];
	const quote = (value: Identifier): string => {
		const maximum =
			dialect === "postgresql"
				? 63
				: dialect === "mysql" || dialect === "mariadb"
					? 64
					: undefined;
		if (maximum !== undefined && value.name.length > maximum) {
			throw new Error(`SQL identifier exceeds the ${dialect} identifier length limit`);
		}
		const delimiter = dialect === "mysql" || dialect === "mariadb" ? "`" : '"';

		return `${delimiter}${value.name}${delimiter}`;
	};
	const bind = (value: SqlParameter): string => {
		params.push(value);

		return dialect === "postgresql" ? `$${params.length}` : "?";
	};
	const expression = (value: SqlExpression): string => {
		if (value.kind === "parameter") {
			return bind(value);
		}

		return value.table ? `${quote(value.table)}.${quote(value.name)}` : quote(value.name);
	};
	const predicate = (value: SqlPredicate): string => {
		if (value.kind === "and" || value.kind === "or") {
			return `(${value.predicates.map(predicate).join(value.kind === "and" ? " AND " : " OR ")})`;
		}
		if (value.kind === "is-null" || value.kind === "is-not-null") {
			return `(${expression(value.expression)} IS ${value.kind === "is-not-null" ? "NOT " : ""}NULL)`;
		}
		if (value.kind !== "comparison") {
			throw new Error("Unsupported SQL predicate kind");
		}
		const leftNull = value.left.kind === "parameter" && value.left.type === "null";
		const rightNull = value.right.kind === "parameter" && value.right.type === "null";
		if (leftNull || rightNull) {
			const operand =
				leftNull && rightNull ? "NULL" : expression(leftNull ? value.right : value.left);

			return `(${operand} IS ${value.operator === "ne" ? "NOT " : ""}NULL)`;
		}
		const operators = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

		return `(${expression(value.left)} ${operators[value.operator]} ${expression(value.right)})`;
	};
	const projection = ast.columns.map((value) => {
		const text = expression(value.expression);

		return value.alias ? `${text} AS ${quote(value.alias)}` : text;
	});
	const table = ast.from.schema
		? `${quote(ast.from.schema)}.${quote(ast.from.name)}`
		: quote(ast.from.name);
	let text = `SELECT ${projection.join(", ")} FROM ${table}`;
	if (ast.from.alias) {
		text += ` AS ${quote(ast.from.alias)}`;
	}
	if (ast.where) {
		text += ` WHERE ${predicate(ast.where)}`;
	}
	if (ast.orderBy && ast.orderBy.length > 0) {
		text += ` ORDER BY ${ast.orderBy.map((value) => `${expression(value.expression)} ${value.direction === "asc" ? "ASC" : "DESC"}`).join(", ")}`;
	}
	if (ast.limit !== undefined) {
		text += ` LIMIT ${bind(parameter("integer", ast.limit))}`;
	}
	if (ast.offset !== undefined) {
		text += ` OFFSET ${bind(parameter("integer", ast.offset))}`;
	}

	return Object.freeze({ text, params: Object.freeze(params) });
}
