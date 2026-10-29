# Framework source rules

- Keep `src/` limited to framework implementation and public contracts.
- Never import from `examples/` or place demonstration-only code in this tree.
- Keep Kernel behavior transport-agnostic; add transports through `ProfileDriver` implementations outside the core.
- Cover public behavior and failure paths in `tests/` whenever source behavior changes.
