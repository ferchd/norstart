import {
	SQL_OPTIONS,
	SqlClient,
	initializeSql,
	shutdownSql,
	sqlOptionsFromConfiguration,
} from "norstar/sql";
import type { ApplicationExtension } from "norstar/core";
import configuration from "../framework.toml";

export class DatabaseConfiguration {
	readonly #options = sqlOptionsFromConfiguration(configuration.sql);

	get url() {
		return this.#options.url;
	}

	get dialect() {
		return this.#options.dialect;
	}

	get closeTimeoutSeconds() {
		return this.#options.closeTimeoutSeconds;
	}
}

const extension: ApplicationExtension = {
	name: "sql",
	providers: [
		{ token: SQL_OPTIONS, useClass: DatabaseConfiguration, inject: [], lifetime: "singleton" },
		{ token: SqlClient, useClass: SqlClient, inject: [SQL_OPTIONS], lifetime: "singleton" },
	],
	initialize: initializeSql,
	shutdown: shutdownSql,
};

export default extension;
