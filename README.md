# Norstar

Norstar is a Bun-first framework with a transport-agnostic Kernel and an HTTP profile built on `Bun.serve()`.

## Example

Runnable demonstrations are isolated under [`examples/`](examples/). Run the kernel demo with `bun run start` or the HTTP demo with `bun run start:http`.

## Core contract

`Application.configure()` reads and validates `framework.toml`. `.create()` builds the manifest and Kernel without starting profiles. `.run()` bootstraps, starts, supervises and shuts down the application. `Application.stop()` requests a controlled stop. The public composition entry point is `src/index.ts`; the transport-agnostic core remains available from `src/core/index.ts`.

Profiles are described by named `[profiles.<id>]` TOML tables. A `ProfileDriver` creates a `ProfileInstance`; the Kernel only uses the generic instance lifecycle (`mode`, `finished`, `start`, `stop`). Adding another transport means implementing and registering a driver. The Kernel has no HTTP, TCP, routing or database code.

## Application extensions

Pass reusable capabilities through `Application.configure({ extensions: [extension] })`. An `ApplicationExtension` has a unique `name`, optional `dependencies` containing other extension names, and optional `register`, `initialize`, and `shutdown` hooks. Norstar validates the complete dependency graph before registration and uses a stable dependency order. It captures the dependency names and hook references when creating the application.

`register(services)` synchronously adds factories to the application's existing `Container` during `create()`. It must not open external resources or return a promise. Compiled service factories register first, then extensions, then `configureServices`. `initialize({ services, signal })` runs after application service modules load and before profile bootstrap. Dependencies initialize first; `create()` never initializes extensions. The resolver is shared with profiles and application services.

Shutdown stops profiles first, then calls extension `shutdown({ services })` hooks in reverse initialization order, then disposes container services. A partially initialized extension also receives shutdown. Shutdown continues after individual cleanup errors and reports failures through the existing Kernel result. Initialization receives a lifetime cancellation signal; shutdown has no deadline signal and must settle promptly. The Kernel bounds the caller's shutdown wait, but JavaScript promises cannot be forcibly cancelled. If initialization settles late after cancellation, Norstar cleans that extension up once before disposing its services.

This first extension API uses explicit programmatic wiring. Register extension factories and their dependencies directly in `register`; compiler discovery cannot infer providers hidden inside extension hooks for automatic constructor injection. Import extensions normally from the application entry point to include them in `norstar build`; there is no separate extension container or Kernel. See [the extensions demo](examples/extensions-demo/README.md).

## HTTP profile

The public package entry point registers the HTTP profile automatically. Configure service modules and route modules in TOML:

```toml
[application]
serviceModules = ["src/services.ts"]
profileDrivers = ["@acme/norstar-worker"]

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

Each module listed in `profileDrivers` must default-export one `ProfileDriver`. `norstar check` resolves the modules without evaluating them, and `norstar build` and `norstar dev` statically include them in the generated application. Install each driver package in the application before running these commands. For direct, uncompiled runtime use, pass drivers through `Application.configure({ drivers })` because creating an application remains synchronous.

When a driver provides TypeScript source or declarations, `check` also validates its default export against the framework's `ProfileDriver` contract. JavaScript packages without declarations receive definitive export validation when `Application.create()` runs; neither `check` nor `build` evaluates package code to inspect runtime values.

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

## Compiler and CLI

Run `norstar init my-app` to create a minimal HTTP application, then run `bun install` and `bun run dev` in the new directory. Initialization is non-interactive, publishes the generated tree atomically, and refuses to overwrite a non-empty target. Private Norstar installations require `--framework <specifier>` to select a stable local tarball or checkout; published packages use their own version by default.

Run `norstar check`, `norstar build`, or `norstar dev` from an application directory. In this checkout use `bun run norstar <command>`. The CLI accepts `--config framework.toml`, `--entry src/main.ts`, and `--outdir dist`.

The compiler discovers exported classes in `src/**/*.service.ts` and `src/**/*.controller.ts`, infers constructor dependencies from class types, and validates missing registrations, circular dependencies, and singleton dependencies on scoped services. Controllers default to scoped lifetime; services default to transient. Explicit `static norstarService` metadata overrides these defaults. Configure `[application].discovery` with an array of glob patterns or use `serviceModules` for explicit modules.

`check` validates the framework graph and TypeScript syntax and types without evaluating application modules or writing artifacts. It respects the local `tsconfig.json`; without one it checks TypeScript files under `src/` plus explicit service, route, and entry modules with strict Bun-compatible defaults. Available Bun and Node ambient types are enabled by default; an explicit `compilerOptions.types` selection takes precedence. `--entry` includes custom application entries in the validation. Diagnostics identify the file, position, and TypeScript error code. `build` generates `.norstar/manifest.ts` with static references, includes configured HTTP routes, and bundles a production entry in `dist/`. The bundle retains `Application.configure().create().run()` and runs without the original source files, directory scanning, or TOML parsing. `dev` recompiles and restarts on source and configuration changes. See [the compiled example](examples/compiled-app/README.md).

This initial compiler requires concrete classes without inheritance, class-typed constructor dependencies or explicit static injection arrays, and class or exported `Symbol()` tokens. Dynamic metadata, `Symbol.for()` tokens, top-level await in configured route dependency graphs, TOML dates, and non-finite configuration numbers produce diagnostics.

The explicit runtime loader remains available for development integrations. Stopping during service loading cancels registration and lets shutdown finish without waiting for module evaluation; JavaScript module side effects already in progress cannot be cancelled. The Kernel has no dependency on the compiler or CLI.

## Project policies

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [MIT License](LICENSE)
