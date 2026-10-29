# Contributing

Thanks for helping improve Norstar. Contributions should preserve the project's goal: a Bun-first application framework with a transport-agnostic core.

## Before you start

- Open an issue or discussion for a substantial feature or architectural change.
- Keep changes focused and explain the problem they solve.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Use Bun 1.4.4 or newer, then install the locked dependencies:

```sh
bun install --frozen-lockfile
```

Before opening a pull request, run:

```sh
bun run format
bun run verify
```

Add or update contract tests when changing application configuration, profile drivers, lifecycle behavior, failure handling, or shutdown behavior.

## Architecture and style

- Keep the Kernel independent of HTTP, TCP, UDP, CLI, and other profile details.
- Add new application capabilities through profile drivers wherever possible.
- Keep blocks multi-line, use one statement per line, and follow the repository's Prettier and ESLint rules.
- Do not add runtime dependencies without explaining why the capability belongs in the core.

## Commits

Use Conventional Commits:

```text
feat(kernel): support finite profiles
fix: stop profiles after startup failure
docs: clarify the contribution workflow
```

The `commit-msg` hook enforces the commit format. Use a concise subject, add a body when more context is useful, and mark incompatible changes with a `BREAKING CHANGE:` footer.

## Pull requests

- Describe the behavior and motivation for the change.
- Link related issues or discussions.
- Summarize tests and checks you ran.
- Call out compatibility changes and follow-up work.
