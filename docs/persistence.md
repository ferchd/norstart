# Persistence contracts

Norstar's persistence modules use Bun's native capabilities and share the framework's existing extension and dependency injection boundaries. SQL generation belongs outside the Kernel and works independently of HTTP or any other profile.

## Dependency policy

Official runtime modules must require zero third party npm packages, including code embedded in a production bundle. Development and compilation tools remain permitted: TypeScript Compiler API, ESLint, Prettier, Husky, Commitlint, and ambient types continue to support development.

Running without `node_modules` alone does not establish this policy: a bundle can contain third party code. The production audit inspects the bundler's contribution graph and retained external dependencies, and CI checks the official runtime. Applications can still choose external extensions and dependencies; those choices are visible in their build report.

The audit combines [Bun build metadata](https://bun.com/docs/bundler#metafile) with parsing of emitted JavaScript imports and requires. It checks the statically resolved graph; arbitrary variable-based loading and the provenance of copied source code are outside this check. This is a dependency regression gate for the official runtime, not a proof about arbitrary user code.

`norstar build` writes `dependencies.json` beside the generated manifest, normally `.norstar/dependencies.json`. It reports contributed third party files, retained external packages and files, native imports, and unresolved dynamic loads. Builds continue to allow user-selected integrations; CI applies the zero-dependency assertion to the official runtime fixture and reviews its remaining dynamic module-loading path.

TypeScript remains a compiler dependency in the current distribution. Changing its dependency classification without separating the compiler distribution would break installed CLI consumers. Packaging separation is a later milestone; this first gate checks what enters runtime bundles.

## SQL and query modules

`norstar/sql` exposes typed parameter contracts, the Bun.SQL client, and lifecycle helpers. `norstar/query` exposes immutable AST construction and SQL compilation. Both runtime modules use native APIs and remain independent of the TypeScript compiler.

```typescript
import { parameter } from "norstar/sql";
import { column, compare, compileQuery, identifier, selectQuery } from "norstar/query";

const query = selectQuery({
	from: { name: identifier("users") },
	columns: [{ expression: column("id") }, { expression: column("name") }],
	where: compare("eq", column("name"), parameter("text", "Ana")),
	orderBy: [{ expression: column("id"), direction: "asc" }],
	limit: 10,
});

const compiled = compileQuery(query, "postgresql");
```

The result contains SQL text with placeholders and a separate ordered array of typed parameters. User values never become SQL text. Pagination values are also bound parameters. The SQL client converts the typed parameters to native bindings.

`CompiledQuery` is an inspection result, not an execution capability. `SqlClient.execute()` receives an AST and obtains executable text through the compiler. It rejects arbitrary objects containing SQL text.

Identifiers are validated independently of values. Schema, table, column, and alias names use separate identifier nodes; dotted paths and arbitrary SQL fragments are not identifier inputs. There is no raw SQL expression node or public SQL template API. This initial identifier grammar is intentionally conservative.

The AST supports SELECT projections, schema-qualified table sources, aliases, comparisons, logical predicates, explicit null predicates, ordering, and limit/offset pagination. Offset requires a limit in this portable subset. Compilation uses PostgreSQL positional placeholders and question mark placeholders for the other dialects; quoting is selected by dialect.

The typed parameter contract distinguishes text, safe integers, bigint, decimal strings, booleans, canonical UTC timestamp strings (`YYYY-MM-DDTHH:mm:ss.sssZ`), and null. Non-finite or unsafe numbers, invalid decimal/timestamp values, unknown node kinds, and unsupported operators are rejected at runtime as well as constrained by TypeScript. Explicit null predicates are available; equality and inequality against a typed null parameter compile to `IS NULL` and `IS NOT NULL`. Ordering comparisons against null are rejected.

These are AST construction functions, not the future LINQ query interface. Schema/model inference and expression compatibility based on model columns belong to later stages.

## SQL client and lifecycle

`SqlClient` construction validates and snapshots configuration without constructing a native pool or opening a database. Call `connect()` during application initialization. Queries require an established connection; `close()` and `dispose()` are idempotent and prevent reopening the client.

```typescript
import { SqlClient } from "norstar/sql";
import { column, identifier, selectQuery } from "norstar/query";

const client = new SqlClient({ url: ":memory:", dialect: "sqlite" });
await client.connect();

try {
	const tables = await client.transaction(async (transaction) => {
		return transaction.execute(
			selectQuery({
				from: { name: identifier("sqlite_master") },
				columns: [{ expression: column("name") }],
			}),
		);
	});
	console.log(tables);
} finally {
	await client.close();
}
```

Transaction callbacks use an explicit handle. Root-client calls inside that callback are rejected; there is no implicit routing of queries into transactions. Handles expire when callbacks finish, issued queries drain before commit, and any issued query failure rejects the transaction even when the callback catches it. Nested transactions and savepoints are not exposed in this first client API. PostgreSQL and MySQL-family transactions use native reserved connections. SQLite operations outside a transaction queue until it finishes because Bun's SQLite adapter uses one connection.

Closing rejects new root operations and drains accepted work within `closeTimeoutSeconds`, then closes the native pool with the remaining time. Cancellation of `connect(signal)` closes the client and prevents a late connection from reopening it. JavaScript callbacks cannot be forcibly terminated: closing can finish while a noncooperative callback remains pending, and its native connection is no longer usable. There is no automatic transaction retry; a connection failure during commit can leave the outcome indeterminate.

Options are explicit `url` and `dialect`, with optional `maxConnections` (default 10), `connectionTimeoutSeconds` (default 10), and `closeTimeoutSeconds` (default 5). URLs must match the selected dialect; there is no implicit selection from database environment variables. TLS settings in the URL are passed to Bun, including `sslmode=require` and certificate-verifying modes. SQLite always uses a single connection. Integer bindings are safe JavaScript numbers; bigint bindings must fit signed 64-bit values. SQLite enables exact integer decoding and normalizes only safe integers to `number`; larger values remain `bigint`. Network adapters use Bun's bigint decoding. Decimal parameters remain strings. Timestamps remain canonical strings for PostgreSQL and SQLite; MySQL and MariaDB receive native Date values for UTC datetime encoding. SQLite boolean parameters bind as 1 or 0. Row values otherwise retain native decoding; the optional generic row type is an annotation, not runtime schema validation.

## Configuration and extensions

For direct programmatic applications, `createSqlExtension(options)` registers the default `SQL_OPTIONS` and `SqlClient` singleton factories, connects during initialization, and closes after profiles stop. Each application receives its own client. The configuration is captured when creating the extension.

Compiled applications use declarative providers for `SQL_OPTIONS` and `SqlClient` with `initializeSql` and `shutdownSql` lifecycle hooks. The [SQL client example](../examples/sql-client/README.md) imports TOML as bundled data and resolves environment values when its configuration provider is instantiated at runtime:

```toml
[sql]
dialect = "sqlite"
url = ":memory:"
urlEnvironment = "NORSTAR_DATABASE_URL"
closeTimeoutSeconds = 1
```

`sqlOptionsFromConfiguration(table)` maps this table to client options. An environment override takes precedence; an explicitly empty override fails instead of using the fallback. Put credentials in environment variables rather than bundled TOML. Numeric ranges and URL/dialect compatibility are validated by the client constructor. The parser does not read files: importing configuration as data keeps compiled artifacts independent of their original TOML and source files.

The public query contract remains SELECT-only. Read transaction success, callback failure, handle expiry, binding behavior, and connection cleanup are tested locally with SQLite. CI additionally runs the native PostgreSQL, MySQL, and MariaDB integration suite against isolated service containers. Run it locally with all three `NORSTAR_TEST_POSTGRESQL_URL`, `NORSTAR_TEST_MYSQL_URL`, and `NORSTAR_TEST_MARIADB_URL` values set:

```sh
bun test ./tests/sql/databases.integration.ts
```

That explicit suite fails when a required URL is absent. Its fixtures create and remove their own uniquely named tables using native test-only setup queries. Data-changing AST nodes and write-rollback execution coverage belong to the later query-writing milestone.

## Roadmap

1. SQL contracts, typed parameters, SELECT AST, dialect generation, and a production dependency gate.
2. A `norstar/sql` client using Bun.SQL, connection lifecycle through extensions, DI, and transactions.
3. LINQ style queries and typed schema/model construction.
4. Advanced SQL nodes: CTE, recursive queries, unions, joins, subqueries, aggregates, windows, and writes.
5. ORM persistence, relations, and mapping.
6. Laravel style migrations and Schema Builder, with history, checksums, concurrency locks, and engine-specific DDL guarantees.
7. CLI integration, compiler/runtime distribution separation, and expanded multi-database execution and security tests.

Future syntax is not accepted silently by the initial compiler. Each additional AST node and dialect capability must define validation, parameter ordering, and execution tests before becoming public.
