interface PostToolUseInput {
	cwd?: string;
}

const inputText = await Bun.stdin.text();
let input: PostToolUseInput = {};

try {
	input = JSON.parse(inputText) as PostToolUseInput;
} catch {
	// Use the process working directory when Codex does not provide hook input.
}

const result = Bun.spawnSync(["bun", "run", "lint"], {
	cwd: input.cwd || process.cwd(),
	stdout: "pipe",
	stderr: "pipe",
});

if (result.exitCode === 0) {
	process.exit(0);
}

const output = [result.stdout, result.stderr]
	.map((buffer) => new TextDecoder().decode(buffer).trim())
	.filter(Boolean)
	.join("\n")
	.slice(-4000);

console.log(
	JSON.stringify({
		decision: "block",
		reason: `Lint failed after editing. Fix these issues before continuing.\n${output}`,
	}),
);
