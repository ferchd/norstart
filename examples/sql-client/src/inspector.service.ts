import { SqlClient } from "norstar/sql";
import { column, identifier, selectQuery } from "norstar/query";

export class Inspector {
	constructor(private readonly database: SqlClient) {}

	async tables(): Promise<readonly Record<string, unknown>[]> {
		return this.database.transaction(async (transaction) => {
			return transaction.execute(
				selectQuery({
					from: { name: identifier("sqlite_master") },
					columns: [{ expression: column("name") }, { expression: column("type") }],
				}),
			);
		});
	}
}
