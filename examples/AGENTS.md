# Example rules

- Keep runnable demonstrations and sample configuration isolated under `examples/`.
- Examples may consume the framework public API; framework source and package exports must never depend on examples.
- Keep demo-specific dependencies, fixtures, and documentation out of the core implementation.
- Validate examples with `bun run typecheck` and `bun run start` when they change.
