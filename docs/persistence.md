# Persistence contracts

Norstar's persistence modules use Bun's native capabilities and share the framework's existing extension and dependency injection boundaries. SQL generation belongs outside the Kernel and works independently of HTTP or any other profile.

## Dependency policy

Official runtime modules must require zero third party npm packages, including code embedded in a production bundle. Development and compilation tools remain permitted: TypeScript Compiler API, ESLint, Prettier, Husky, Commitlint, and ambient types continue to support development.

Running without `node_modules` alone does not establish this policy: a bundle can contain third party code. The production audit inspects the bundler's contribution graph and retained external dependencies, and CI checks the official runtime. Applications can still choose external extensions and dependencies; those choices are visible in their build report.

The audit combines [Bun build metadata](https://bun.com/docs/bundler#metafile) with parsing of emitted JavaScript imports and requires. It checks the statically resolved graph; arbitrary variable-based loading and the provenance of copied source code are outside this check. This is a dependency regression gate for the official runtime, not a proof about arbitrary user code.

`norstar build` writes `dependencies.json` beside the generated manifest, normally `.norstar/dependencies.json`. It reports contributed third party files, retained external packages and files, native imports, and unresolved dynamic loads. Builds continue to allow user-selected integrations; CI applies the zero-dependency assertion to the official runtime fixture and reviews its remaining dynamic module-loading path.

TypeScript remains a compiler dependency in the current distribution. Changing its dependency classification without separating the compiler distribution would break installed CLI consumers. Packaging separation is a later milestone; this first gate checks what enters runtime bundles.

## SQL and query modules

`norstar/sql` exposes dialect and typed parameter contracts. `norstar/query` exposes immutable AST construction and SQL compilation. Neither module imports the TypeScript compiler, manages connections, or evaluates SQL.

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

The result contains SQL text with placeholders and a separate ordered array of typed parameters. User values never become SQL text. Pagination values are also bound parameters. Parameter metadata remains available for the future Bun.SQL adapter to convert and bind values appropriately.

`CompiledQuery` is an inspection result, not an execution capability. The future SQL client must obtain executable text through the AST compiler rather than trust arbitrary user-created objects containing a `text` field.

Identifiers are validated independently of values. Schema, table, column, and alias names use separate identifier nodes; dotted paths and arbitrary SQL fragments are not identifier inputs. There is no raw SQL expression node or public SQL template API. This initial identifier grammar is intentionally conservative.

The AST supports SELECT projections, schema-qualified table sources, aliases, comparisons, logical predicates, explicit null predicates, ordering, and limit/offset pagination. Offset requires a limit in this portable subset. Compilation uses PostgreSQL positional placeholders and question mark placeholders for the other dialects; quoting is selected by dialect.

The typed parameter contract distinguishes text, safe integers, bigint, decimal strings, booleans, canonical UTC timestamp strings (`YYYY-MM-DDTHH:mm:ss.sssZ`), and null. Non-finite or unsafe numbers, invalid decimal/timestamp values, unknown node kinds, and unsupported operators are rejected at runtime as well as constrained by TypeScript. Explicit null predicates are available; equality and inequality against a typed null parameter compile to `IS NULL` and `IS NOT NULL`. Ordering comparisons against null are rejected.

These are AST construction functions, not the future LINQ query interface. Schema/model inference and expression compatibility based on model columns belong to later stages. SQLite execution tests use Bun's native SQLite API to verify emitted SQL and binding order; other dialect tests verify generation without claiming server integration coverage.

## Roadmap

1. SQL contracts, typed parameters, SELECT AST, dialect generation, and a production dependency gate.
2. A `norstar/sql` client using Bun.SQL, connection lifecycle through extensions, DI, and transactions.
3. LINQ style queries and typed schema/model construction.
4. Advanced SQL nodes: CTE, recursive queries, unions, joins, subqueries, aggregates, windows, and writes.
5. ORM persistence, relations, and mapping.
6. Laravel style migrations and Schema Builder, with history, checksums, concurrency locks, and engine-specific DDL guarantees.
7. CLI integration, compiler/runtime distribution separation, and expanded multi-database execution and security tests.

Future syntax is not accepted silently by the initial compiler. Each additional AST node and dialect capability must define validation, parameter ordering, and execution tests before becoming public.
