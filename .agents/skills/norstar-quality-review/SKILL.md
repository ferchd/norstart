---
name: norstar-quality-review
description: Review Norstar changes for correctness, architecture, security, regression risk, and test gaps, then verify the complete repository quality gate. Use when reviewing a diff, finishing an implementation, investigating a regression, or preparing a pull request.
---

# Norstar quality review

1. Read `AGENTS.md`, inspect the complete diff, and trace affected behavior through source and tests.
2. Check correctness, lifecycle and failure paths, API compatibility, architecture boundaries, examples isolation, and security-sensitive changes.
3. Confirm every behavior change has focused tests; do not treat lint or type checking as a substitute for tests.
4. Run `bun run verify` and inspect the exit status and full output.
5. Report actionable findings first with file and symbol references. If there are no findings, state the tested scope and any remaining untested edge cases.
