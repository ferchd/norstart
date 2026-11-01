# SQL AST foundation

From the repository root, run `bun run examples/sql-ast/main.ts`.

The same immutable query is compiled for each supported dialect. The name value contains SQL syntax intentionally: it remains a bound parameter and never appears in the generated SQL text.

This example compiles queries; it does not open database connections. Connection management and execution belong to the next persistence milestone.
