import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildApplication } from "../../src/cli/build.ts";

test("bundles statically imported extensions and their shared services", async () => {
	const directory = await mkdtemp(join(process.cwd(), ".norstar-cli-test-extensions-"));
	try {
		await mkdir(join(directory, "src"));
		await writeFile(join(directory, "framework.toml"), '[profiles.job]\ntype = "job"');
		await writeFile(
			join(directory, "src/extension.ts"),
			`import type { ApplicationExtension } from "norstar/core";
export const MESSAGE = Symbol("message");
export const extension: ApplicationExtension = {
	name: "message",
	register(services) {
		services.register(MESSAGE, () => ({
			text: "extension service",
			dispose() {
				console.log("dispose");
			},
		}), "singleton");
	},
	initialize() {
		console.log("initialize");
	},
	shutdown() {
		console.log("shutdown");
	},
};`,
		);
		await writeFile(
			join(directory, "src/main.ts"),
			`import { Application } from "norstar";
import { extension, MESSAGE } from "./extension.ts";
await Application.configure({
	extensions: [extension],
	drivers: [{
		type: "job",
		create(context) {
			return {
				mode: "finite",
				finished: Promise.resolve(),
				start() {
					console.log(context.services.get<{ text: string }>(MESSAGE).text);
				},
				stop() {
					console.log("profile stop");
				},
			};
		},
	}],
}).create().run();`,
		);
		const output = await buildApplication(
			{
				command: "build",
				configPath: "framework.toml",
				entry: "src/main.ts",
				outdir: "dist",
			},
			directory,
		);
		await rm(join(directory, "src"), { recursive: true });
		await rm(join(directory, "framework.toml"));
		await rm(join(directory, ".norstar"), { recursive: true });
		const child = Bun.spawn([process.execPath, output], {
			cwd: directory,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);

		expect(code).toBe(0);
		expect(stderr).toBe("");
		expect(stdout.trim().split(/\r?\n/)).toEqual([
			"initialize",
			"extension service",
			"profile stop",
			"shutdown",
			"dispose",
		]);
	} finally {
		await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}, 30000);
