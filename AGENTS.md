# Codex project guide

## Project

Norstar is a Bun-first application framework. Its core is transport-agnostic: HTTP, TCP, UDP, CLI, and worker support belong in registered profile drivers, not in the Kernel.

Framework implementation belongs in `src/`. Runnable demonstrations and sample profiles belong in `examples/`; do not import example code from the framework or place demo entry points/configuration at the repository root.

## Architecture guardrails

- Preserve the public `Application.configure().create().run()` flow.
- `create()` must not start profiles or other external resources.
- Keep `ProfileDriver` and `ProfileInstance` as the extension boundary. A new transport should not require changes to the Kernel contract.
- Keep TOML parsing and manifest creation outside the Kernel.
- Add or update contract coverage for lifecycle, failure, and shutdown behavior.
- Always run the relevant test suite after code changes; typechecking and linting do not replace tests.
- Before finishing a code change, run `bun run verify` and report the actual result. Never claim a check passed unless it exited successfully.
- Delegate independent test design and architecture/security review to the project agents when the task benefits from parallel review; integrate and verify every finding before finishing.
- Use the `norstar-feature-development` skill for framework features and `norstar-quality-review` for review or final verification tasks.

## Code style

- Write every function, control-flow, loop, `try`/`catch`, and class block as a multi-line block. Never put a block body beside its opening brace or collapse a control statement and its body onto one line.
- Put one statement on each line. Do not combine `try`/`catch`, conditionals, returns, throws, or assignments into compressed lines.
- Separate logical sections with a blank line, especially after validation and before the final return. Avoid both dense blocks and excessive blank lines.
- Use tabs for indentation and keep lines within the configured Prettier width. Run `bun run format` on changed files, then `bun run lint`.
- Keep code easy to scan. Do not shorten code by sacrificing clear indentation or block separation.

## Commit messages

- Follow Conventional Commits: `<type>(optional-scope): <imperative description>`.
- Use a standard type such as `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, or `revert`.
- Keep the subject concise, lowercase after the colon, and under 100 characters. Do not end it with a period.
- Use a body for context when needed and a `BREAKING CHANGE:` footer for incompatible changes.
- Examples: `feat(kernel): support finite profiles`, `fix: close services after startup failure`, `docs: explain commit conventions`.

## Commands

- `bun run lint` runs ESLint.
- `bun run typecheck` runs the TypeScript checker.
- `bun test` runs the contract tests.
- `bun run verify` runs lint, type checks, and the complete test suite.
- `bun run start` runs the isolated example in `examples/kernel-demo/`.

Run the linter after code changes. The project-local Codex `Stop` hook also runs it and asks Codex to continue if it fails. Run lint, typecheck, and tests before considering an implementation complete.
