import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArguments } from "../../src/cli/arguments.ts";

const cliPath = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

async function withApplication(operation: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(process.cwd(), ".norstar-cli-test-"));
	try {
		await mkdir(join(directory, "src"));
		await writeFile(join(directory, "framework.toml"), '[profiles.job]\ntype = "job"\n');
		await writeFile(
			join(directory, "src/message.service.ts"),
			`
import { appendFileSync } from "node:fs";
await Promise.resolve();
appendFileSync(${JSON.stringify(join(directory, "evaluated.txt"))}, "evaluated\\n");
export class Message {
	static readonly norstarService = { lifetime: "singleton", inject: [] };
	text = "compiled service";
}
`,
		);
		await writeFile(join(directory, "src/main.ts"), 'import "./launch.ts";\n');
		await writeFile(
			join(directory, "src/launch.ts"),
			`
import { Application } from "norstar";
import { Message } from "./message.service.ts";
await Application.configure({ drivers: [{
	type: "job",
	create(context) {
		return {
			mode: "finite",
			finished: Promise.resolve(),
			start() {
				console.log(context.services.get(Message).text);
			},
			stop() {},
		};
	},
}] }).create().run();
`,
		);
		await operation(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function execute(arguments_: string[], directory: string) {
	const child = Bun.spawn([process.execPath, cliPath, ...arguments_], {
		cwd: directory,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);

	return { exitCode, stdout, stderr };
}

describe("Norstar CLI", () => {
	test("parses commands and rejects malformed arguments", () => {
		expect(parseArguments(["build", "--entry", "app.ts"]).entry).toBe("app.ts");
		expect(parseArguments(["dev"]).command).toBe("dev");
		for (const arguments_ of [
			[],
			["unknown"],
			["check", "--unknown", "x"],
			["build", "--entry"],
			["build", "--entry", "a.ts", "--entry", "b.ts"],
		]) {
			expect(() => parseArguments(arguments_)).toThrow();
		}
	});

	test("check validates without executing services or writing a manifest", async () => {
		await withApplication(async (directory) => {
			const result = await execute(["check"], directory);
			expect(result.stderr).toBe("");
			expect(result.exitCode).toBe(0);
			expect(await Bun.file(join(directory, "evaluated.txt")).exists()).toBe(false);
			expect(await Bun.file(join(directory, ".norstar/manifest.ts")).exists()).toBe(false);
		});
	}, 20000);

	test("build emits a runnable application independent of source and TOML", async () => {
		await withApplication(async (directory) => {
			const result = await execute(["build"], directory);
			expect(result.stderr).toBe("");
			expect(result.exitCode).toBe(0);
			expect(await Bun.file(join(directory, "evaluated.txt")).exists()).toBe(false);
			await rm(join(directory, "src"), { recursive: true });
			await rm(join(directory, "framework.toml"));
			await rm(join(directory, ".norstar"), { recursive: true });
			const child = Bun.spawn([process.execPath, join(directory, "dist/main.js")], {
				cwd: directory,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(stdout).toContain("compiled service");
			expect(await readFile(join(directory, "evaluated.txt"), "utf8")).toBe("evaluated\n");
		});
	}, 20000);

	test("invalid commands fail with a nonzero exit status", async () => {
		const result = await execute(["unknown"], process.cwd());
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Usage: norstar");
	});

	test("build reports invalid entry syntax with a nonzero exit status", async () => {
		await withApplication(async (directory) => {
			await writeFile(join(directory, "src/main.ts"), "export const invalid = ;");
			const result = await execute(["build"], directory);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("main.ts");
			expect(result.stderr).toContain("TS1109");
		});
	}, 20000);

	test.each(["check", "build"])(
		"%s rejects semantic errors in a custom entry without evaluating it",
		async (command) => {
			await withApplication(async (directory) => {
				await writeFile(
					join(directory, "custom-entry.ts"),
					'throw new Error("entry evaluated");\nexport const value: number = "wrong";',
				);
				const result = await execute([command, "--entry", "custom-entry.ts"], directory);
				expect(result.exitCode).toBe(1);
				expect(result.stderr).toContain("TS2322");
				expect(result.stderr).toContain("custom-entry.ts");
				expect(result.stderr).not.toContain("at throwDiagnostics");
				expect(await Bun.file(join(directory, "evaluated.txt")).exists()).toBe(false);
				expect(await Bun.file(join(directory, ".norstar/manifest.ts")).exists()).toBe(
					false,
				);
			});
		},
		20000,
	);

	test("dev rebuilds after a source change", async () => {
		await withApplication(async (directory) => {
			const child = Bun.spawn([process.execPath, cliPath, "dev"], {
				cwd: directory,
				stdout: "ignore",
				stderr: "pipe",
			});
			const stderr = new Response(child.stderr).text();
			const evaluationsPath = join(directory, "evaluated.txt");
			const waitForEvaluations = async (count: number): Promise<void> => {
				for (let attempt = 0; attempt < 200; attempt++) {
					const content = await readFile(evaluationsPath, "utf8").catch(() => "");
					if (content.trim().split("\n").filter(Boolean).length >= count) {
						return;
					}

					await Bun.sleep(50);
				}

				throw new Error(`Dev did not produce ${count} application evaluations`);
			};
			try {
				await waitForEvaluations(1);
				const servicePath = join(directory, "src/message.service.ts");
				const source = await readFile(servicePath, "utf8");
				await writeFile(servicePath, source.replace("compiled service", "updated service"));
				await waitForEvaluations(2);
				expect(await readFile(evaluationsPath, "utf8")).toContain("evaluated\nevaluated\n");
			} finally {
				child.kill("SIGTERM");
				await child.exited;
			}

			expect(await stderr).toBe("");
		});
	}, 30000);
});
