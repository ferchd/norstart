export type SqlDialect = "postgresql" | "mysql" | "mariadb" | "sqlite";

export interface SqlParameterValues {
	readonly text: string;
	readonly integer: number;
	readonly bigint: bigint;
	readonly decimal: string;
	readonly boolean: boolean;
	readonly timestamp: string;
	readonly null: null;
}

export type SqlParameterType = keyof SqlParameterValues;

export type SqlParameter<T extends SqlParameterType = SqlParameterType> = {
	[K in T]: Readonly<{ kind: "parameter"; type: K; value: SqlParameterValues[K] }>;
}[T];

export interface CompiledQuery {
	readonly text: string;
	readonly params: readonly SqlParameter[];
}
