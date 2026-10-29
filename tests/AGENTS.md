# Test rules

- Add regression or contract tests for every behavior change.
- Keep tests and test-only helpers in `tests/`; never ship them from `src/`.
- Prefer observable contract assertions over implementation details.
- Cover success, invalid input, failures, and cleanup when relevant.
- Do not weaken assertions, skip tests, or leave process-global state modified.
