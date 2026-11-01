import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArguments } from "../../src/cli/arguments.ts";
import { publishToExistingDirectory } from "../../src/cli/init.ts";

const cliPath = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const repository = fileURLToPath(new URL("../../", import.meta.url));

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
		await rm(directory, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	}
}

async function execute(arguments_: string[], directory: string) {
	return executeCommand([process.execPath, cliPath, ...arguments_], directory);
}

async function executeCommand(command: string[], directory: string) {
	const child = Bun.spawn(command, {
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

async function waitForHealth(port: number): Promise<unknown> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`);
			if (response.ok) {
				return response.json();
			}
		} catch {
			// The child has not started listening yet.
		}

		await Bun.sleep(50);
	}

	throw new Error("External application did not expose its health route");
}

async function terminateChild(child: ReturnType<typeof Bun.spawn>): Promise<void> {
	if (process.platform === "win32") {
		const termination = Bun.spawn(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await termination.exited;
	} else {
		child.kill("SIGTERM");
	}

	await child.exited;
}

describe("Norstar CLI", () => {
	test("parses commands and rejects malformed arguments", () => {
		expect(parseArguments(["build", "--entry", "app.ts"])).toMatchObject({
			entry: "app.ts",
		});
		expect(parseArguments(["dev"]).command).toBe("dev");
		expect(parseArguments(["init", "my-app", "--framework", "file:../norstar"])).toEqual({
			command: "init",
			directory: "my-app",
			framework: "file:../norstar",
		});
		for (const arguments_ of [
			[],
			["unknown"],
			["check", "--unknown", "x"],
			["build", "--entry"],
			["build", "--entry", "a.ts", "--entry", "b.ts"],
			["init", "one", "two"],
			["init", "--framework"],
		]) {
			expect(() => parseArguments(arguments_)).toThrow();
		}
	});

	test("init creates a standalone project and refuses a non-empty target", async () => {
		const directory = await mkdtemp(join(tmpdir(), "norstar init "));
		try {
			const result = await execute(
				["init", "application", "--framework", `file:${repository}`],
				directory,
			);
			const application = join(directory, "application");

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(await Bun.file(join(application, "src/main.ts")).text()).toContain(
				"Application.configure().create().run()",
			);
			expect(await Bun.file(join(application, "src/routes.ts")).text()).toContain(
				'Route.get("/health", health)',
			);
			expect(await Bun.file(join(application, "tests/health.test.ts")).exists()).toBe(true);
			const packageSource = await Bun.file(join(application, "package.json")).json();
			expect(packageSource.dependencies.norstar).toBe(`file:${repository}`);
			expect(packageSource.devDependencies).toMatchObject({
				"@types/bun": "^1.4.4",
				"@types/node": "^26.6.6",
			});

			const repeated = await execute(
				["init", "application", "--framework", `file:${repository}`],
				directory,
			);
			expect(repeated.exitCode).toBe(1);
			expect(repeated.stderr).toContain("must be empty");

			await writeFile(join(directory, "not-a-directory"), "preserve");
			const fileTarget = await execute(["init", "not-a-directory"], directory);
			expect(fileTarget.exitCode).toBe(1);
			expect(fileTarget.stderr).toContain("regular directory");
			expect(await Bun.file(join(directory, "not-a-directory")).text()).toBe("preserve");

			const privateDefault = await execute(["init", "without-framework"], directory);
			expect(privateDefault.exitCode).toBe(1);
			expect(privateDefault.stderr).toContain("require --framework");
			expect(await Bun.file(join(directory, "without-framework")).exists()).toBe(false);

			await mkdir(join(directory, "empty"));
			const emptyTarget = await execute(
				["init", "empty", "--framework", `file:${repository}`],
				directory,
			);
			expect(emptyTarget.exitCode).toBe(0);
			expect(await Bun.file(join(directory, "empty/package.json")).exists()).toBe(true);

			const currentDirectory = join(directory, "current-directory");
			await mkdir(currentDirectory);
			const probe = join(directory, "cwd-probe.ts");
			await writeFile(
				probe,
				`import { runCli } from ${JSON.stringify(pathToFileURL(cliPath).href)};
await runCli(["init", ".", "--framework", ${JSON.stringify(`file:${repository}`)}]);
console.log(process.cwd());
`,
			);
			const currentTarget = await executeCommand([process.execPath, probe], currentDirectory);
			expect(currentTarget.exitCode).toBe(0);
			expect(currentTarget.stderr).toBe("");
			expect(currentTarget.stdout).toContain(currentDirectory);
			expect(await Bun.file(join(currentDirectory, "package.json")).exists()).toBe(true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 20000);

	test("existing-directory publication preserves collisions and rolls back partial output", async () => {
		const directory = await mkdtemp(join(tmpdir(), "norstar init collision "));
		try {
			const staging = join(directory, "staging");
			const target = join(directory, "target");
			await Promise.all([mkdir(staging), mkdir(target)]);
			await Promise.all([
				writeFile(join(staging, "a-generated.txt"), "generated"),
				writeFile(join(staging, "z-collision.txt"), "generated"),
				writeFile(join(target, "z-collision.txt"), "user"),
			]);

			await expect(publishToExistingDirectory(staging, target)).rejects.toThrow();
			expect(await Bun.file(join(target, "a-generated.txt")).exists()).toBe(false);
			expect(await Bun.file(join(target, "z-collision.txt")).text()).toBe("user");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("the packaged CLI initializes and builds an external application", async () => {
		const directory = await mkdtemp(join(tmpdir(), "norstar external "));
		try {
			const artifacts = join(directory, "artifacts");
			const runner = join(directory, "runner");
			const application = join(directory, "application");
			await Promise.all([mkdir(artifacts), mkdir(runner)]);
			const archive = join(artifacts, "norstar-0.1.0.tgz");
			const packed = await executeCommand(
				[process.execPath, "pm", "pack", "--ignore-scripts", "--destination", artifacts],
				repository,
			);
			expect(packed.exitCode).toBe(0);
			await writeFile(
				join(runner, "package.json"),
				JSON.stringify({ private: true, dependencies: { norstar: `file:${archive}` } }),
			);
			const runnerInstall = await executeCommand(
				[process.execPath, "install", "--ignore-scripts", "--backend=copyfile"],
				runner,
			);
			expect(runnerInstall.exitCode).toBe(0);
			const initialized = await executeCommand(
				[
					process.execPath,
					"run",
					"--no-install",
					"norstar",
					"init",
					application,
					"--framework",
					`file:${archive}`,
				],
				runner,
			);
			expect(initialized.exitCode).toBe(0);
			const generatedPackage = await Bun.file(join(application, "package.json")).json();
			expect(generatedPackage.dependencies.norstar).toBe(`file:${archive}`);
			const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
			const port = reservation.port;
			await reservation.stop(true);
			if (port === undefined) {
				throw new Error("Bun did not allocate a test port");
			}
			const configuration = await Bun.file(join(application, "framework.toml")).text();
			await writeFile(
				join(application, "framework.toml"),
				configuration.replace("port = 3000", `port = ${port}`),
			);
			const installed = await executeCommand(
				[process.execPath, "install", "--ignore-scripts"],
				application,
			);
			expect(installed.exitCode).toBe(0);
			for (const command of ["test", "typecheck", "check", "build"]) {
				const result = await executeCommand(
					[process.execPath, "run", "--no-install", command],
					application,
				);
				if (result.exitCode !== 0) {
					throw new Error(`${command} failed:\n${result.stdout}${result.stderr}`);
				}
				expect(result.exitCode).toBe(0);
			}
			expect(await Bun.file(join(application, "dist/main.js")).exists()).toBe(true);

			for (const command of [
				[process.execPath, "run", "--no-install", "dev"],
				[process.execPath, join(application, "dist/main.js")],
			]) {
				const child = Bun.spawn(command, {
					cwd: application,
					stdout: "ignore",
					stderr: "ignore",
				});
				try {
					expect(await waitForHealth(port)).toEqual({ status: "ok" });
				} finally {
					await terminateChild(child);
				}
			}
		} finally {
			await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}, 90000);

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

	test("loads a config-declared external driver into the standalone build", async () => {
		const directory = await mkdtemp(join(tmpdir(), "norstar-external-driver-"));
		try {
			const inputs = join(directory, "inputs");
			const application = join(inputs, "application");
			const artifacts = join(inputs, "artifacts");
			const runtime = join(directory, "runtime");
			const packageDirectory = join(inputs, "driver");
			await mkdir(join(application, "src"), { recursive: true });
			await Promise.all([mkdir(artifacts), mkdir(runtime)]);
			await mkdir(packageDirectory, { recursive: true });
			await writeFile(
				join(packageDirectory, "package.json"),
				JSON.stringify({
					name: "@norstar-test/external-driver",
					version: "1.0.0",
					type: "module",
					exports: { import: "./index.js" },
				}),
			);
			await writeFile(
				join(packageDirectory, "index.js"),
				`import { appendFileSync } from "node:fs";
appendFileSync("driver-loaded.txt", "loaded\\n");

export default {
	type: "external-job",
	create() {
		return {
			mode: "finite",
			finished: new Promise((resolve) => queueMicrotask(resolve)),
			start() {
				console.log("external driver started");
			},
			stop() {
				appendFileSync("driver-stopped.txt", "stopped\\n");
			},
		};
	},
};
`,
			);
			for (const source of [repository, packageDirectory]) {
				const packed = await executeCommand(
					[
						process.execPath,
						"pm",
						"pack",
						"--ignore-scripts",
						"--destination",
						artifacts,
					],
					source,
				);
				if (packed.exitCode !== 0) {
					throw new Error(`Package creation failed:\n${packed.stdout}${packed.stderr}`);
				}
			}
			const frameworkPackage = await Bun.file(join(repository, "package.json")).json();
			await writeFile(
				join(application, "package.json"),
				JSON.stringify({
					private: true,
					dependencies: {
						norstar: `file:${join(artifacts, `norstar-${frameworkPackage.version}.tgz`)}`,
						"@norstar-test/external-driver": `file:${join(artifacts, "norstar-test-external-driver-1.0.0.tgz")}`,
					},
				}),
			);
			const installed = await executeCommand(
				[process.execPath, "install", "--ignore-scripts", "--backend=copyfile"],
				application,
			);
			if (installed.exitCode !== 0) {
				throw new Error(
					`External driver install failed:\n${installed.stdout}${installed.stderr}`,
				);
			}
			await writeFile(
				join(application, "framework.toml"),
				'[application]\nprofileDrivers = ["@norstar-test/external-driver"]\n\n[profiles.job]\ntype = "external-job"\n',
			);
			await writeFile(
				join(application, "src/main.ts"),
				'import { Application } from "norstar";\nawait Application.configure().create().run();\n',
			);

			const checked = await executeCommand(
				[process.execPath, "run", "--no-install", "norstar", "check"],
				application,
			);
			if (checked.exitCode !== 0) {
				throw new Error(
					`External driver check failed:\n${checked.stdout}${checked.stderr}`,
				);
			}
			expect(checked.exitCode).toBe(0);
			expect(await Bun.file(join(application, "driver-loaded.txt")).exists()).toBe(false);
			const built = await executeCommand(
				[process.execPath, "run", "--no-install", "norstar", "build"],
				application,
			);
			if (built.exitCode !== 0) {
				throw new Error(`External driver build failed:\n${built.stdout}${built.stderr}`);
			}
			expect(built.exitCode).toBe(0);
			expect(await Bun.file(join(application, "driver-loaded.txt")).exists()).toBe(false);

			await copyFile(join(application, "dist/main.js"), join(runtime, "main.js"));
			await rm(inputs, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			expect(await readdir(directory)).toEqual(["runtime"]);
			expect(await readdir(runtime)).toEqual(["main.js"]);
			const artifact = await executeCommand(
				[process.execPath, join(runtime, "main.js")],
				runtime,
			);

			expect(artifact.exitCode).toBe(0);
			expect(artifact.stderr).toBe("");
			expect(artifact.stdout).toContain("external driver started");
			expect(await Bun.file(join(runtime, "driver-loaded.txt")).text()).toBe("loaded\n");
			expect(await Bun.file(join(runtime, "driver-stopped.txt")).text()).toBe("stopped\n");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 90000);

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
