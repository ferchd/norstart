import { SQL } from "bun";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, column, compare, identifier, selectQuery } from "../../src/query/index.ts";
import { SqlClient, parameter } from "../../src/sql/index.ts";
import type { SqlDialect, SqlTransaction } from "../../src/sql/index.ts";

const engines = [
	{ dialect: "postgresql", variable: "NORSTAR_TEST_POSTGRESQL_URL" },
	{ dialect: "mysql", variable: "NORSTAR_TEST_MYSQL_URL" },
	{ dialect: "mariadb", variable: "NORSTAR_TEST_MARIADB_URL" },
] as const;

function requiredUrl(variable: string): string {
	const url = process.env[variable];
	if (!url) {
		throw new Error(`The explicit SQL integration suite requires ${variable}`);
	}

	return url;
}

function quoted(name: string, dialect: SqlDialect): string {
	const quote = dialect === "postgresql" ? '"' : "`";

	return `${quote}${name}${quote}`;
}

test.each(engines)(
	"executes native $dialect bindings and read transactions against an isolated fixture",
	async ({ dialect, variable }) => {
		const url = requiredUrl(variable);
		const native = new SQL(url);
		const client = new SqlClient({ url, dialect, maxConnections: 2 });
		const table = `norstar_test_${randomUUID().replaceAll("-", "")}`;
		const tableSql = quoted(table, dialect);
		const hostile = "O'Reilly'); DROP TABLE important_data; --";
		const timestamp = "2026-11-01T12:34:56.123Z";
		const amount = "12345678901234567890.12500";
		const large = 2n ** 63n - 1n;
		const timestampType = dialect === "postgresql" ? "TIMESTAMPTZ" : "DATETIME(3)";
		let created = false;
		try {
			await native.unsafe(
				`CREATE TABLE ${tableSql} (
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					created_at ${timestampType},
					amount DECIMAL(30,5),
					large_value BIGINT,
					enabled BOOLEAN,
					optional_value TEXT NULL
				)`,
			);
			created = true;
			const typedPlaceholders =
				dialect === "postgresql" ? "$1, $2, $3, $4, $5, $6, $7" : "?, ?, ?, ?, ?, ?, ?";
			await native.unsafe(
				`INSERT INTO ${tableSql}
					(id, name, created_at, amount, large_value, enabled, optional_value)
					VALUES (${typedPlaceholders})`,
				[1, hostile, new Date(timestamp), amount, large, true, null],
			);
			const placeholders = dialect === "postgresql" ? "$1, $2" : "?, ?";
			await native.unsafe(`INSERT INTO ${tableSql} (id, name) VALUES (${placeholders})`, [
				2,
				"second",
			]);
			const query = selectQuery({
				from: { name: identifier(table) },
				columns: [
					{ expression: column(identifier("id")) },
					{ expression: column(identifier("name")) },
					{ expression: column(identifier("created_at")) },
					{ expression: column(identifier("amount")) },
					{ expression: column(identifier("large_value")) },
					{ expression: column(identifier("enabled")) },
					{ expression: column(identifier("optional_value")) },
				],
				where: and(
					compare("eq", column(identifier("id")), parameter("integer", 1)),
					compare("eq", column(identifier("name")), parameter("text", hostile)),
					compare(
						"eq",
						column(identifier("created_at")),
						parameter("timestamp", timestamp),
					),
					compare("eq", column(identifier("amount")), parameter("decimal", amount)),
					compare("eq", column(identifier("large_value")), parameter("bigint", large)),
					compare("eq", column(identifier("enabled")), parameter("boolean", true)),
					compare("eq", column(identifier("optional_value")), parameter("null", null)),
				),
				orderBy: [{ expression: column(identifier("id")), direction: "asc" }],
				limit: 1,
				offset: 0,
			});
			await client.connect();
			const rows = await client.execute(query);

			expect(rows).toHaveLength(1);
			expect(Number(rows[0]?.id)).toBe(1);
			expect(rows[0]?.name).toBe(hostile);
			expect(rows[0]?.created_at).toBeInstanceOf(Date);
			expect((rows[0]?.created_at as Date).toISOString()).toBe(timestamp);
			expect(rows[0]?.amount).toBe(amount);
			expect(rows[0]?.large_value).toBe(large);
			expect(rows[0]?.enabled).toBe(dialect === "postgresql" ? true : 1);
			expect(rows[0]?.optional_value).toBeNull();
			let expired: SqlTransaction | undefined;
			const result = await client.transaction(async (transaction) => {
				expired = transaction;
				const transactionRows = await transaction.execute(query);
				expect(transactionRows[0]?.name).toBe(hostile);

				return "completed";
			});
			expect(result).toBe("completed");
			expect(expired).toBeDefined();
			await expect(expired!.execute(query)).rejects.toThrow();
			const failure = new Error("intentional read transaction failure");
			await expect(
				client.transaction(async (transaction) => {
					await transaction.execute(query);
					throw failure;
				}),
			).rejects.toBe(failure);
			expect((await client.execute(query))[0]?.name).toBe(hostile);
			const count = await native.unsafe(`SELECT COUNT(*) AS total FROM ${tableSql}`);
			expect(Number(count[0]?.total)).toBe(2);
		} finally {
			await client.close();
			try {
				if (created) {
					await native.unsafe(`DROP TABLE ${tableSql}`);
				}
			} finally {
				await native.close();
			}
		}
	},
	30000,
);
