import { SQL } from "bun";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { column, compare, identifier, selectQuery } from "../../src/query/index.ts";
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
		let created = false;
		try {
			await native.unsafe(
				`CREATE TABLE ${tableSql} (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`,
			);
			created = true;
			const placeholders = dialect === "postgresql" ? "$1, $2" : "?, ?";
			await native.unsafe(`INSERT INTO ${tableSql} (id, name) VALUES (${placeholders})`, [
				1,
				hostile,
			]);
			await native.unsafe(`INSERT INTO ${tableSql} (id, name) VALUES (${placeholders})`, [
				2,
				"second",
			]);
			const query = selectQuery({
				from: { name: identifier(table) },
				columns: [
					{ expression: column(identifier("id")) },
					{ expression: column(identifier("name")) },
				],
				where: compare("eq", column(identifier("name")), parameter("text", hostile)),
				orderBy: [{ expression: column(identifier("id")), direction: "asc" }],
				limit: 1,
				offset: 0,
			});
			await client.connect();
			const rows = await client.execute(query);

			expect(rows).toHaveLength(1);
			expect(Number(rows[0]?.id)).toBe(1);
			expect(rows[0]?.name).toBe(hostile);
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
