---
name: norstar-feature-development
description: Implement or change Norstar framework behavior while preserving architecture boundaries, readable formatting, tests, and verification. Use when adding a core feature, changing a profile lifecycle, configuration, manifest, service container, or example.
---

# Norstar feature development

1. Read the root `AGENTS.md` and the closest nested `AGENTS.md` files.
2. Trace the existing public contract and identify whether the change belongs in `src/`, `tests/`, or `examples/`.
3. Keep framework code transport-agnostic. Add integrations through profile drivers; keep runnable demos in `examples/` and never import them into `src/`.
4. Add or update tests with the behavior change. Cover success, invalid input, failure, and cleanup where applicable.
5. Use multi-line blocks, one statement per line, tabs, and logical blank lines. Do not compress control flow.
6. Run `bun run format` on changed files, then `bun run verify`.
7. Review the final diff for unintended files and report commands and results accurately.
