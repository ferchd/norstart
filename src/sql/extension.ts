import type {
	ApplicationExtension,
	ExtensionContext,
	ExtensionShutdownContext,
} from "../core/extensions.ts";
import { SQL_OPTIONS, SqlClient } from "./client.ts";
import type { SqlClientOptions } from "./client.ts";

export async function initializeSql({ services, signal }: ExtensionContext): Promise<void> {
	await services.get(SqlClient).connect(signal);
}

export async function shutdownSql({ services }: ExtensionShutdownContext): Promise<void> {
	await services.get(SqlClient).close();
}

export function createSqlExtension(options: SqlClientOptions): ApplicationExtension {
	const configuration = Object.freeze({ ...options });

	const extension: ApplicationExtension = {
		name: "sql",
		register(services) {
			services.register(SQL_OPTIONS, () => configuration, "singleton");
			services.register(
				SqlClient,
				(resolver) => new SqlClient(resolver.get<SqlClientOptions>(SQL_OPTIONS)),
				"singleton",
			);
		},
		initialize: initializeSql,
		shutdown: shutdownSql,
	};

	return Object.freeze(extension);
}
