interface StopHookInput {
	cwd?: string;
	stop_hook_active?: boolean;
}

const inputText = await Bun.stdin.text();
let input: StopHookInput = {};

try {
	input = JSON.parse(inputText) as StopHookInput;
} catch {
	// Use the process working directory when Codex does not provide hook input.
}

const cwd = input.cwd || process.cwd();
const checks = ["bun run lint", "bun run typecheck", "bun test"];
const failures: string[] = [];

for (const check of checks) {
	const result = Bun.spawnSync(check.split(" "), {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = [result.stdout, result.stderr]
		.map((buffer) => new TextDecoder().decode(buffer).trim())
		.filter(Boolean)
		.join("\n")
		.slice(-4000);

	if (result.exitCode !== 0) {
		failures.push(`${check} failed (exit ${result.exitCode}).\n${output}`);
	}
}

if (failures.length === 0) {
	process.exit(0);
}

const detail = failures.join("\n\n");
const message = `Norstar quality gate failed. Fix the checks below before finishing:\n${detail}`;

if (input.stop_hook_active) {
	console.log(JSON.stringify({ systemMessage: message }));
	process.exit(0);
}

console.log(JSON.stringify({ decision: "block", reason: message }));
