# Norstar

First milestone: a minimal Bun application core that coordinates multiple profile drivers without depending on a transport.

## Example

The runnable kernel demo is isolated in [`examples/kernel-demo/`](examples/kernel-demo/). Run it with `bun run start`; its walkthrough and sample configuration live beside the example.

## Core contract

`Application.configure()` reads and validates `framework.toml`. `.create()` builds the manifest and Kernel without starting profiles. `.run()` bootstraps, starts, supervises and shuts down the application. `Application.stop()` requests a controlled stop. The framework entry point is `src/core/index.ts`.

Profiles are described by named `[profiles.<id>]` TOML tables. A `ProfileDriver` creates a `ProfileInstance`; the Kernel only uses the generic instance lifecycle (`mode`, `finished`, `start`, `stop`). Adding another transport means implementing and registering a driver. The Kernel has no HTTP, TCP, routing or database code.

```toml
[application]
name = "my-app"

[profiles.api]
type = "http-server"
port = 3000
```

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

## Project policies

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [MIT License](LICENSE)
