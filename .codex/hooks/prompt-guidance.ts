console.log(
	JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "UserPromptSubmit",
			additionalContext:
				"Norstar quality rules: preserve the transport-agnostic core and examples separation; add or update tests for every behavior change; keep blocks multi-line and statements one per line; run bun run verify before declaring completion. Use the matching Norstar skill and delegate independent review to the configured agents when useful.",
		},
	}),
);
