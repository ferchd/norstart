import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProfileDriver, ProfileInstance } from "../../src/core/contracts.ts";
import { Application } from "../../src/core/application.ts";
import { withTemporaryDirectory } from "./helpers.ts";

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});

	return { promise, resolve, reject };
}

async function createConfig(directory: string): Promise<string> {
	const configPath = join(directory, "framework.toml");
	await writeFile(configPath, '[profiles.main]\ntype = "test"');

	return configPath;
}

describe("Application", () => {
	test("returns one run promise and stops through the application facade", async () => {
		await withTemporaryDirectory(async (directory) => {
			const configPath = await createConfig(directory);
			const started = deferred();
			const finished = deferred();
			let stopCalls = 0;
			const driver: ProfileDriver = {
				type: "test",
				create: () =>
					createInstance(started, finished, () => {
						stopCalls++;
					}),
			};
			const application = Application.configure({ configPath, drivers: [driver] }).create();

			const firstRun = application.run();
			expect(application.run()).toBe(firstRun);
			await started.promise;
			const result = await application.stop("requested");

			expect(result.status).toBe("stopped");
			expect(await firstRun).toBe(result);
			expect(stopCalls).toBe(1);
		});
	});

	test("does not start profiles when stopped during bootstrap", async () => {
		await withTemporaryDirectory(async (directory) => {
			const configPath = await createConfig(directory);
			const createEntered = deferred();
			const allowCreateToFinish = deferred();
			let startCalls = 0;
			let stopCalls = 0;
			const driver: ProfileDriver = {
				type: "test",
				create: async () => {
					createEntered.resolve();
					await allowCreateToFinish.promise;

					return {
						mode: "persistent",
						finished: new Promise<void>(() => {}),
						start: () => {
							startCalls++;
						},
						stop: () => {
							stopCalls++;
						},
					};
				},
			};
			const application = Application.configure({ configPath, drivers: [driver] }).create();
			const run = application.run();
			await createEntered.promise;
			const stop = application.stop("requested");
			allowCreateToFinish.resolve();

			const [result, stopResult] = await Promise.all([run, stop]);

			expect(result).toEqual(stopResult);
			expect(result.status).toBe("stopped");
			expect(result.exitCode).toBe(0);
			expect(startCalls).toBe(0);
			expect(stopCalls).toBe(1);
		});
	});

	test("waits for a pending profile start before completing a requested stop", async () => {
		await withTemporaryDirectory(async (directory) => {
			const configPath = await createConfig(directory);
			const startEntered = deferred();
			const allowStartToFinish = deferred();
			let stopCalls = 0;
			const driver: ProfileDriver = {
				type: "test",
				create: () => ({
					mode: "persistent",
					finished: new Promise<void>(() => {}),
					start: async () => {
						startEntered.resolve();
						await allowStartToFinish.promise;
					},
					stop: () => {
						stopCalls++;
					},
				}),
			};
			const application = Application.configure({ configPath, drivers: [driver] }).create();
			const run = application.run();
			await startEntered.promise;
			const stop = application.stop("requested");
			allowStartToFinish.resolve();

			const [result, stopResult] = await Promise.all([run, stop]);

			expect(result).toEqual(stopResult);
			expect(result.status).toBe("stopped");
			expect(result.exitCode).toBe(0);
			expect(stopCalls).toBe(1);
		});
	});

	test("resolves run after a finite profile completes", async () => {
		await withTemporaryDirectory(async (directory) => {
			const configPath = await createConfig(directory);
			const finished = deferred();
			const driver: ProfileDriver = {
				type: "test",
				create: () => ({
					mode: "finite",
					finished: finished.promise,
					start: () => finished.resolve(),
					stop: () => undefined,
				}),
			};
			const application = Application.configure({ configPath, drivers: [driver] }).create();

			expect((await application.run()).status).toBe("completed");
		});
	});

	test("sets the process exit code when run resolves with a failed result", async () => {
		await withTemporaryDirectory(async (directory) => {
			const configPath = await createConfig(directory);
			const started = deferred();
			const finished = deferred();
			const driver: ProfileDriver = {
				type: "test",
				create: () => ({
					mode: "persistent",
					finished: finished.promise,
					start: () => started.resolve(),
					stop: () => undefined,
				}),
			};
			const application = Application.configure({ configPath, drivers: [driver] }).create();
			const originalExitCode = process.exitCode;
			const originalConsoleError = console.error;
			console.error = () => undefined;

			try {
				const run = application.run();
				await started.promise;
				await new Promise((resolve) => setTimeout(resolve, 0));
				finished.reject(new Error("profile crashed"));

				const result = await run;

				expect(result.status).toBe("failed");
				expect(result.exitCode).toBe(1);
				expect(process.exitCode).toBe(1);
			} finally {
				process.exitCode = originalExitCode ?? 0;
				console.error = originalConsoleError;
			}
		});
	});

	test("reports a startup failure and sets the process exit code", async () => {
		await withTemporaryDirectory(async (directory) => {
			const configPath = await createConfig(directory);
			const driver: ProfileDriver = {
				type: "test",
				create: (): ProfileInstance => ({
					mode: "persistent",
					finished: new Promise<void>(() => {}),
					start: () => {
						throw new Error("startup failed");
					},
					stop: () => undefined,
				}),
			};
			const application = Application.configure({ configPath, drivers: [driver] }).create();
			const originalExitCode = process.exitCode;
			const originalConsoleError = console.error;
			console.error = () => undefined;

			try {
				await expect(application.run()).rejects.toThrow("startup failed");
				await new Promise((resolve) => setTimeout(resolve, 0));
				expect(process.exitCode).toBe(1);
			} finally {
				process.exitCode = originalExitCode ?? 0;
				console.error = originalConsoleError;
			}
		});
	});
});

function createInstance(
	started: { promise: Promise<void>; resolve(): void },
	finished: { promise: Promise<void>; resolve(): void },
	onStop: () => void,
): ProfileInstance {
	return {
		mode: "persistent",
		finished: finished.promise,
		start: () => started.resolve(),
		stop: () => {
			onStop();
			finished.resolve();
		},
	};
}
