console.log(
	JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "SessionStart",
			additionalContext:
				"Norstar project checks are enforced at commit and turn completion. Use bun run verify (lint + typecheck + tests). Keep framework code in src/, tests in tests/, and runnable demonstrations in examples/. Follow AGENTS.md and the applicable project skill.",
		},
	}),
);
