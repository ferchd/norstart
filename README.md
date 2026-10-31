# Norstar

Norstar is a Bun-first framework with a transport-agnostic Kernel and an HTTP profile built on `Bun.serve()`.

## Example

Runnable demonstrations are isolated under [`examples/`](examples/). Run the kernel demo with `bun run start` or the HTTP demo with `bun run start:http`.

## Core contract

`Application.configure()` reads and validates `framework.toml`. `.create()` builds the manifest and Kernel without starting profiles. `.run()` bootstraps, starts, supervises and shuts down the application. `Application.stop()` requests a controlled stop. The public composition entry point is `src/index.ts`; the transport-agnostic core remains available from `src/core/index.ts`.

Profiles are described by named `[profiles.<id>]` TOML tables. A `ProfileDriver` creates a `ProfileInstance`; the Kernel only uses the generic instance lifecycle (`mode`, `finished`, `start`, `stop`). Adding another transport means implementing and registering a driver. The Kernel has no HTTP, TCP, routing or database code.

## HTTP profile

The public package entry point registers the HTTP profile automatically. Configure service modules and route modules in TOML:

```toml
[application]
serviceModules = ["src/services.ts"]

[profiles.http]
type = "http-server"
port = 3000
hostname = "127.0.0.1"

[profiles.http.routes]
api = "src/routes/api.ts"
```

Route modules import `Route` from `norstar/http` and declare handlers independently of `Application`:

```typescript
import { Route } from "norstar/http";

Route.get("/health", () => ({ status: "ok" }));
```

The application entry point stays the same:

```typescript
import { Application } from "norstar";

Application.configure().create().run();
```

Handlers may return a `Response`, string, JSON-serializable value, or `undefined`. Class controller targets use `[Controller, "method"]`. Export service classes from configured modules with `static norstarService` metadata containing `lifetime` and constructor `inject` tokens; Norstar loads that manifest before profile bootstrap. Request scopes are disposed after the response body completes or is cancelled. `HttpError` 4xx messages are exposed by default; 5xx errors return a generic message unless created with `{ expose: true }`. The application handles `SIGINT` and `SIGTERM`, drains active requests and force-closes the server only when the Kernel's shutdown deadline expires.

The HTTP demo includes a local throughput comparison with a native `Bun.serve()` endpoint. Run it with `bun run benchmark:http`; results depend on the machine and environment.

## Acceptance checks

```sh
bun run verify
```

The contract tests cover configuration and manifest creation, finite and persistent profile coordination, automatic completion, fatal profile errors, reverse-order shutdown and registering a future transport without changing the Kernel.

## Development workflow

- ESLint uses the flat config in `eslint.config.mjs` with the recommended JavaScript and TypeScript rules.
- Prettier and ESLint enforce multi-line blocks, one statement per line, tab indentation, and the configured line width.
- TypeScript 7 remains available through `@typescript/native`; ESLint resolves the TypeScript 6 compatibility API through the `typescript` alias until typescript-eslint supports TypeScript 7's new API.
- Husky runs lint, type checks, and the complete test suite before each Git commit.
- Husky runs Commitlint on the commit message and enforces Conventional Commits.
- Codex reads project instructions from `AGENTS.md`, loads project-scoped agents from `.codex/agents/` and skills from `.agents/skills/`, and runs project hooks after edits and before finishing a turn. Project-local hooks must be reviewed and trusted in Codex before they execute.
- GitHub Actions runs the same quality gate on pushes and pull requests. CodeQL scans the TypeScript and workflow code; Dependabot tracks Bun dependencies and GitHub Actions.

## Discovery and compilation status

Service discovery currently imports explicitly configured modules during `run()` and reads their static `norstarService` metadata. The manifest is built from TOML at runtime. Stopping during service loading cancels registration and lets shutdown finish without waiting for module evaluation; JavaScript module side effects already in progress cannot be cancelled.

The next compiler and CLI milestone remains open. Its acceptance criteria are convention-based service and controller discovery, a generated static manifest, dependency and lifetime validation before execution, and application startup from that artifact through `Application.configure().create().run()`. It must preserve the transport-agnostic Kernel and keep examples isolated.

## Project policies

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [MIT License](LICENSE)
