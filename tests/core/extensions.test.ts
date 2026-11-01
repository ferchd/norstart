import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Application } from "../../src/core/application.ts";
import type { ProfileDriver } from "../../src/core/contracts.ts";
import type { ApplicationExtension } from "../../src/core/extensions.ts";
import { withTemporaryDirectory } from "./helpers.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});

	return { promise, resolve };
}

async function configuration(directory: string): Promise<string> {
	const path = join(directory, "framework.toml");
	await writeFile(path, '[profiles.main]\ntype = "job"');

	return path;
}

function finiteDriver(events: string[]): ProfileDriver {
	return {
		type: "job",
		create() {
			events.push("profile:create");
			const finished = deferred();

			return {
				mode: "finite",
				finished: finished.promise,
				start() {
					events.push("profile:start");
					finished.resolve();
				},
				stop() {
					events.push("profile:stop");
				},
			};
		},
	};
}

async function withExpectedFailure(operation: () => Promise<void>): Promise<void> {
	const previousExitCode = process.exitCode;
	const previousConsoleError = console.error;
	console.error = () => undefined;
	try {
		await operation();
		await Bun.sleep(0);
	} finally {
		process.exitCode = previousExitCode ?? 0;
		console.error = previousConsoleError;
	}
}

describe("Application extensions", () => {
	test("rejects asynchronous registration and observes its rejection", async () => {
		await withTemporaryDirectory(async (directory) => {
			const configPath = await configuration(directory);
			expect(() =>
				Application.configure({
					configPath,
					extensions: [
						{
							name: "async-register",
							async register() {
								throw new Error("asynchronous registration rejected");
							},
						},
					],
				}).create(),
			).toThrow("Extension register must be synchronous: async-register");
			await Bun.sleep(0);
		});
	});

	test("snapshots extension dependencies and hooks when creating the application", async () => {
		await withTemporaryDirectory(async (directory) => {
			const configPath = await configuration(directory);
			const events: string[] = [];
			const base = {
				name: "base",
				initialize() {
					events.push("base:initialize");
				},
				shutdown() {
					events.push("base:shutdown");
				},
			};
			const dependent = {
				name: "dependent",
				dependencies: ["base"],
				initialize() {
					events.push("dependent:initialize");
				},
				shutdown() {
					events.push("dependent:shutdown");
				},
			};
			const extensions: ApplicationExtension[] = [dependent, base];
			const app = Application.configure({
				configPath,
				extensions,
				drivers: [finiteDriver(events)],
				handleProcessSignals: false,
			}).create();
			dependent.name = "changed";
			dependent.dependencies.push("missing");
			dependent.initialize = () => {
				events.push("mutated:initialize");
			};
			base.shutdown = () => {
				events.push("mutated:shutdown");
			};
			extensions.push({
				name: "late",
				initialize() {
					events.push("late:initialize");
				},
			});

			expect((await app.run()).status).toBe("completed");
			expect(events).toEqual([
				"base:initialize",
				"dependent:initialize",
				"profile:create",
				"profile:start",
				"profile:stop",
				"dependent:shutdown",
				"base:shutdown",
			]);
		});
	});

	test("orders dependencies, shares the container, and shuts down between profiles and services", async () => {
		await withTemporaryDirectory(async (directory) => {
			const configPath = await configuration(directory);
			const events: string[] = [];
			const resourceToken = Symbol("extension resource");
			const resource = {
				dispose() {
					events.push("service:dispose");
				},
			};
			const extensions: ApplicationExtension[] = [
				{
					name: "dependent",
					dependencies: ["foundation"],
					register() {
						events.push("dependent:register");
					},
					initialize({ services }) {
						expect(services.get(resourceToken)).toBe(resource);
						events.push("dependent:initialize");
					},
					shutdown({ services }) {
						expect(services.get(resourceToken)).toBe(resource);
						events.push("dependent:shutdown");
					},
				},
				{
					name: "foundation",
					register(services) {
						events.push("foundation:register");
						services.register(resourceToken, () => resource, "singleton");
					},
					initialize() {
						events.push("foundation:initialize");
					},
					shutdown() {
						events.push("foundation:shutdown");
					},
				},
			];
			const baseDriver = finiteDriver(events);
			const driver: ProfileDriver = {
				type: "job",
				create(context) {
					expect(context.services.get(resourceToken)).toBe(resource);

					return baseDriver.create(context);
				},
			};
			const app = Application.configure({
				configPath,
				extensions,
				drivers: [driver],
				handleProcessSignals: false,
			}).create();
			expect(events).toEqual(["foundation:register", "dependent:register"]);
			expect((await app.run()).status).toBe("completed");
			expect(events).toEqual([
				"foundation:register",
				"dependent:register",
				"foundation:initialize",
				"dependent:initialize",
				"profile:create",
				"profile:start",
				"profile:stop",
				"dependent:shutdown",
				"foundation:shutdown",
				"service:dispose",
			]);
			await app.stop();
			expect(events.filter((event) => event.endsWith(":shutdown"))).toHaveLength(2);
		});
	});

	test.each([
		["duplicate", [{ name: "same" }, { name: "same" }]],
		["missing dependency", [{ name: "one", dependencies: ["missing"] }]],
		[
			"cycle",
			[
				{ name: "one", dependencies: ["two"] },
				{ name: "two", dependencies: ["one"] },
			],
		],
		["empty name", [{ name: " " }]],
	] as const)("rejects %s before calling register", async (_label, definitions) => {
		await withTemporaryDirectory(async (directory) => {
			const configPath = await configuration(directory);
			let registrations = 0;
			const extensions = definitions.map((definition) => ({
				...definition,
				register() {
					registrations++;
				},
			}));
			expect(() => Application.configure({ configPath, extensions }).create()).toThrow();
			expect(registrations).toBe(0);
		});
	});

	test("rolls back the extension whose initialization failed and its dependencies", async () => {
		await withExpectedFailure(async () => {
			await withTemporaryDirectory(async (directory) => {
				const configPath = await configuration(directory);
				const events: string[] = [];
				const token = Symbol("rollback resource");
				const extensions: ApplicationExtension[] = [
					{
						name: "base",
						register(services) {
							services.register(
								token,
								() => ({
									dispose() {
										events.push("service:dispose");
									},
								}),
								"singleton",
							);
						},
						initialize({ services }) {
							services.get(token);
							events.push("base:initialize");
						},
						shutdown() {
							events.push("base:shutdown");
						},
					},
					{
						name: "broken",
						dependencies: ["base"],
						initialize() {
							events.push("broken:initialize");
							throw new Error("extension failed");
						},
						shutdown() {
							events.push("broken:shutdown");
						},
					},
				];
				const app = Application.configure({
					configPath,
					extensions,
					drivers: [finiteDriver(events)],
					handleProcessSignals: false,
				}).create();

				await expect(app.run()).rejects.toThrow("extension failed");
				expect(events).toEqual([
					"base:initialize",
					"broken:initialize",
					"broken:shutdown",
					"base:shutdown",
					"service:dispose",
				]);
			});
		});
	});

	test("continues extension shutdown and disposes services after a shutdown error", async () => {
		await withExpectedFailure(async () => {
			await withTemporaryDirectory(async (directory) => {
				const configPath = await configuration(directory);
				const events: string[] = [];
				const token = Symbol("disposable");
				const extensions: ApplicationExtension[] = [
					{
						name: "base",
						register(services) {
							services.register(
								token,
								() => ({
									dispose() {
										events.push("service:dispose");
									},
								}),
								"singleton",
							);
						},
						initialize({ services }) {
							services.get(token);
						},
						shutdown() {
							events.push("base:shutdown");
						},
					},
					{
						name: "broken",
						dependencies: ["base"],
						shutdown() {
							events.push("broken:shutdown");
							throw new Error("shutdown failed");
						},
					},
				];
				const app = Application.configure({
					configPath,
					extensions,
					drivers: [finiteDriver(events)],
					handleProcessSignals: false,
				}).create();

				expect((await app.run()).status).toBe("failed");
				expect(events.slice(-3)).toEqual([
					"broken:shutdown",
					"base:shutdown",
					"service:dispose",
				]);
			});
		});
	});

	test("bounds stop during initialization and cleans up a late completion once", async () => {
		await withExpectedFailure(async () => {
			await withTemporaryDirectory(async (directory) => {
				const configPath = await configuration(directory);
				const entered = deferred();
				const release = deferred();
				const cleaned = deferred();
				const events: string[] = [];
				const app = Application.configure({
					configPath,
					drivers: [finiteDriver(events)],
					handleProcessSignals: false,
					shutdownTimeoutMs: 10,
					extensions: [
						{
							name: "pending",
							async initialize({ signal }) {
								entered.resolve();
								await release.promise;
								expect(signal.aborted).toBe(true);
							},
							shutdown() {
								events.push("pending:shutdown");
								cleaned.resolve();
							},
						},
						{
							name: "next",
							initialize() {
								events.push("next:initialize");
							},
						},
					],
				}).create();
				const run = app.run();
				await entered.promise;
				const stop = app.stop();
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const result = await Promise.race([
						run,
						new Promise<never>((_resolve, reject) => {
							timer = setTimeout(
								() =>
									reject(new Error("extension initialization blocked shutdown")),
								500,
							);
						}),
					]);
					expect(await stop).toBe(result);
					expect(events).toEqual([]);
				} finally {
					clearTimeout(timer);
					release.resolve();
				}
				await cleaned.promise;
				await app.stop();
				expect(events).toEqual(["pending:shutdown"]);
			});
		});
	});
});
