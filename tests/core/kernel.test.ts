import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ApplicationConfig,
	ProfileDriver,
	ProfileInstance,
} from "../../src/core/contracts.ts";
import { Application } from "../../src/core/application.ts";
import { Container } from "../../src/core/container.ts";
import { parseConfiguration } from "../../src/core/configuration.ts";
import { Kernel } from "../../src/core/kernel.ts";
import { createManifest } from "../../src/core/manifest.ts";

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});

	return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, timeoutMs = 250): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					reject(new Error(`Operation did not settle within ${timeoutMs} ms`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

function config(types: Record<string, string>): ApplicationConfig {
	return parseConfiguration(
		Object.entries(types)
			.map(([id, type]) => `[profiles.${id}]\ntype = "${type}"`)
			.join("\n\n"),
	);
}

function kernel(
	types: Record<string, string>,
	drivers: readonly ProfileDriver[],
	shutdownTimeoutMs = 100,
	services = new Container(),
) {
	const settings = config(types);

	return new Kernel({
		config: settings,
		manifest: createManifest(settings),
		drivers,
		services,
		shutdownTimeoutMs,
	});
}

describe("Kernel contract", () => {
	test("rejects lifecycle calls made in the wrong state", async () => {
		const done = deferred();
		const driver: ProfileDriver = {
			type: "persistent",
			create: () => instance("server", done.promise, "persistent", []),
		};
		const app = kernel({ server: "persistent" }, [driver]);

		await expect(app.start()).rejects.toThrow('Cannot start Kernel in state "created"');
		await expect(app.waitForExit()).rejects.toThrow('Cannot wait for exit in state "created"');
		await app.bootstrap();
		await expect(app.bootstrap()).rejects.toThrow('Cannot bootstrap Kernel in state "ready"');
		await app.start();
		await expect(app.start()).rejects.toThrow('Cannot start Kernel in state "running"');
		await app.stop();
	});

	test("fails bootstrap when a manifest profile has no registered driver", async () => {
		const app = kernel({ web: "http-server" }, []);

		await expect(app.bootstrap()).rejects.toThrow(
			'No profile driver registered for type "http-server"',
		);
		expect(app.state).toBe("failed");
	});

	test("disposes services after a later driver fails during bootstrap", async () => {
		const events: string[] = [];
		const service = Symbol("bootstrap service");
		const services = new Container();
		services.register(
			service,
			() => ({
				dispose: () => {
					events.push("dispose:service");
				},
			}),
			"singleton",
		);
		const first: ProfileDriver = {
			type: "first",
			create: ({ services: resolver }) => {
				resolver.get(service);

				return instance("first", new Promise<void>(() => {}), "persistent", events);
			},
		};
		const second: ProfileDriver = {
			type: "second",
			create: () => {
				throw new Error("second profile failed to create");
			},
		};
		const app = kernel({ first: "first", second: "second" }, [first, second], 100, services);

		await expect(app.bootstrap()).rejects.toThrow("second profile failed to create");
		const result = await app.stop("failure");

		expect(result.status).toBe("failed");
		expect(events).toEqual(["dispose:service"]);
		expect(await app.stop("requested")).toBe(result);
		expect(events).toEqual(["dispose:service"]);
	});

	test("provides driver-owned scopes without exposing container disposal", async () => {
		const services = new Container();
		const events: string[] = [];
		const scopedToken = Symbol("profile scoped service");
		let contextScopeAvailable = false;
		let resolverCanDisposeContainer = true;
		let resolverIsFrozen = false;
		services.register(
			scopedToken,
			() => ({
				dispose: () => {
					events.push("dispose:scoped");
				},
			}),
			"scoped",
		);
		const driver: ProfileDriver = {
			type: "scoped-profile",
			create: (context) => {
				contextScopeAvailable = typeof context.createScope === "function";
				resolverCanDisposeContainer = "dispose" in context.services;
				resolverIsFrozen = Object.isFrozen(context.services);
				const scope = context.createScope();
				scope.get(scopedToken);

				return instance(
					"scoped-profile",
					new Promise<void>(() => {}),
					"persistent",
					events,
				);
			},
		};
		const app = kernel({ worker: "scoped-profile" }, [driver], 100, services);

		await app.bootstrap();

		expect(contextScopeAvailable).toBe(true);
		expect(resolverCanDisposeContainer).toBe(false);
		expect(resolverIsFrozen).toBe(true);

		await app.stop();

		expect(events).toEqual(["dispose:scoped"]);
	});

	test("rejects duplicate profile driver types", () => {
		const driver: ProfileDriver = {
			type: "worker",
			create: () => {
				throw new Error("unused");
			},
		};

		expect(() => kernel({ task: "worker" }, [driver, driver])).toThrow(
			"Duplicate profile driver: worker",
		);
	});

	test("makes shutdown idempotent and returns the same result", async () => {
		const done = deferred();
		let stopCalls = 0;
		const driver: ProfileDriver = {
			type: "persistent",
			create: () => ({
				...instance("server", done.promise, "persistent", []),
				stop: () => {
					stopCalls++;
					done.resolve();
				},
			}),
		};
		const app = kernel({ server: "persistent" }, [driver]);
		await app.bootstrap();
		await app.start();

		const firstStop = app.stop("requested");
		const secondStop = app.stop("signal");
		expect(secondStop).toBe(firstStop);
		const result = await firstStop;

		expect(result.reason).toBe("requested");
		expect(await app.stop("completed")).toBe(result);
		expect(stopCalls).toBe(1);
	});

	test("marks shutdown as failed and aborts a profile that exceeds its timeout", async () => {
		const done = deferred();
		let shutdownSignal: AbortSignal | undefined;
		const driver: ProfileDriver = {
			type: "persistent",
			create: () => ({
				mode: "persistent",
				finished: done.promise,
				start: () => undefined,
				stop: (signal) => {
					shutdownSignal = signal;

					return new Promise<void>(() => {});
				},
			}),
		};
		const app = kernel({ server: "persistent" }, [driver], 5);
		await app.bootstrap();
		await app.start();

		const result = await app.stop();

		expect(result.status).toBe("failed");
		expect(result.exitCode).toBe(1);
		expect(shutdownSignal?.aborted).toBe(true);
		expect(app.state).toBe("failed");
	});

	test("uses one shutdown deadline across profiles and service disposal", async () => {
		const events: string[] = [];
		const services = new Container();
		const service = Symbol("shutdown service");
		services.register(
			service,
			() => ({
				dispose: () => {
					events.push("dispose:service");
				},
			}),
			"singleton",
		);
		const slowStop: ProfileDriver = {
			type: "slow",
			create: () => ({
				mode: "persistent",
				finished: new Promise<void>(() => {}),
				start: () => undefined,
				stop: async () => {
					events.push("stop:slow");
					await new Promise((resolve) => setTimeout(resolve, 45));
				},
			}),
		};
		const hangingStop: ProfileDriver = {
			type: "hanging",
			create: ({ services: resolver }) => {
				resolver.get(service);

				return {
					mode: "persistent",
					finished: new Promise<void>(() => {}),
					start: () => undefined,
					stop: () => {
						events.push("stop:hanging");

						return new Promise<void>(() => {});
					},
				};
			},
		};
		const app = kernel(
			{ slow: "slow", hanging: "hanging" },
			[slowStop, hangingStop],
			80,
			services,
		);
		await app.bootstrap();
		await app.start();

		const startedAt = Date.now();
		const result = await app.stop();
		const elapsed = Date.now() - startedAt;

		expect(result.status).toBe("failed");
		expect(events).toEqual(["stop:hanging", "stop:slow", "dispose:service"]);
		expect(elapsed).toBeLessThan(125);
	});

	test("bounds shutdown when a profile driver never finishes creating an instance", async () => {
		const createEntered = deferred();
		const driver: ProfileDriver = {
			type: "persistent",
			create: () => {
				createEntered.resolve();

				return new Promise<ProfileInstance>(() => {});
			},
		};
		const app = kernel({ server: "persistent" }, [driver], 10);
		const bootstrap = app.bootstrap();
		await createEntered.promise;

		const result = await within(app.stop());
		await within(bootstrap);

		expect(result.status).toBe("failed");
		expect(result.exitCode).toBe(1);
		expect(app.state).toBe("failed");
	});

	test("bounds shutdown when a profile start operation never settles", async () => {
		const startEntered = deferred();
		const allowStartToFinish = deferred();
		const stopCalled = deferred();
		let stopCalls = 0;
		const driver: ProfileDriver = {
			type: "persistent",
			create: () => ({
				mode: "persistent",
				finished: new Promise<void>(() => {}),
				start: async () => {
					startEntered.resolve();
					await allowStartToFinish.promise;
				},
				stop: () => {
					stopCalls++;
					stopCalled.resolve();
				},
			}),
		};
		const app = kernel({ server: "persistent" }, [driver], 10);
		await app.bootstrap();
		const start = app.start();
		await startEntered.promise;

		const result = await within(app.stop());

		expect(result.status).toBe("failed");
		expect(result.exitCode).toBe(1);
		expect(app.state).toBe("failed");
		expect(stopCalls).toBe(0);

		allowStartToFinish.resolve();
		await within(start);
		await within(stopCalled.promise);

		expect(stopCalls).toBe(1);
		expect(app.state).toBe("failed");
		expect(await app.stop()).toBe(result);
		expect(stopCalls).toBe(1);
	});

	test("cleans up a late-created profile without starting it after shutdown timeout", async () => {
		const createEntered = deferred();
		const allowCreateToFinish = deferred();
		const cleanupCalled = deferred();
		let startCalls = 0;
		let stopCalls = 0;
		const driver: ProfileDriver = {
			type: "persistent",
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
						cleanupCalled.resolve();
					},
				};
			},
		};
		const app = kernel({ server: "persistent" }, [driver], 10);
		const run = app.bootstrap();
		await createEntered.promise;

		const stop = await within(app.stop());
		allowCreateToFinish.resolve();
		await within(cleanupCalled.promise);
		await within(run);

		expect(stop.status).toBe("failed");
		expect(startCalls).toBe(0);
		expect(stopCalls).toBe(1);
		expect(app.state).toBe("failed");
	});

	test("Application.create builds the app without creating or starting profiles", async () => {
		let created = false;
		const drivers: ProfileDriver[] = ["fake-persistent", "fake-finite"].map((type) => ({
			type,
			create: () => {
				created = true;
				throw new Error("create must wait until bootstrap");
			},
		}));
		const directory = await mkdtemp(join(tmpdir(), "norstar-config-test-"));
		const configPath = join(directory, "framework.toml");

		try {
			await writeFile(
				configPath,
				'[profiles.background]\ntype = "fake-persistent"\n[profiles.batch]\ntype = "fake-finite"\n',
			);
			Application.configure({ configPath, drivers }).create();
			expect(created).toBe(false);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("loads strict TOML configuration and builds a static multi-profile manifest", () => {
		const settings = parseConfiguration(
			'[application]\nname="demo"\n[profiles.api]\ntype="http-server"\nport=3000\n[profiles.batch]\ntype="fake-finite"',
		);
		const manifest = createManifest(settings);
		expect(manifest.profiles.map(({ id, type }) => [id, type])).toEqual([
			["api", "http-server"],
			["batch", "fake-finite"],
		]);
		expect(settings.profiles.api!.config).toEqual({ port: 3000 });
		expect(() => parseConfiguration("[profiles.api]\nport=3000")).toThrow("type must be");
	});

	test("a finite profile can finish while a persistent profile stays active until requested shutdown", async () => {
		const events: string[] = [];
		const long = deferred();
		const short = deferred();
		const drivers: ProfileDriver[] = [
			{
				type: "persistent",
				create: () =>
					instance("persistent", long.promise, "persistent", events, long.resolve),
			},
			{
				type: "finite",
				create: () => instance("finite", short.promise, "finite", events, short.resolve),
			},
		];
		const app = kernel({ long: "persistent", short: "finite" }, drivers);
		await app.bootstrap();
		expect(app.state).toBe("ready");
		await app.start();
		short.resolve();
		await Promise.resolve();
		expect(app.state).toBe("running");
		const result = await app.stop("requested");
		expect(result.status).toBe("stopped");
		expect(events).toEqual([
			"start:persistent",
			"start:finite",
			"stop:finite",
			"stop:persistent",
		]);
		expect(app.state).toBe("stopped");
	});

	test("automatically completes when all finite profiles finish", async () => {
		const done = deferred();
		const driver: ProfileDriver = {
			type: "finite",
			create: () => instance("finite", done.promise, "finite", [], done.resolve),
		};
		const app = kernel({ job: "finite" }, [driver]);
		await app.bootstrap();
		await app.start();
		const exited = app.waitForExit();
		done.resolve();
		expect((await exited).status).toBe("completed");
		expect(app.state).toBe("stopped");
	});

	test("a failure in a running profile stops all profiles and reports a fatal result", async () => {
		const failed = deferred();
		const events: string[] = [];
		const persistent: ProfileDriver = {
			type: "persistent",
			create: () => instance("persistent", failed.promise, "persistent", events),
		};
		const app = kernel({ server: "persistent" }, [persistent]);
		await app.bootstrap();
		await app.start();
		const exited = app.waitForExit();
		failed.reject(new Error("profile crashed"));
		const result = await exited;
		expect(result.status).toBe("failed");
		expect(result.exitCode).toBe(1);
		expect(app.state).toBe("failed");
		expect(events).toContain("stop:persistent");
	});

	test("treats a profile rejection with undefined as a failure", async () => {
		const failed = deferred();
		const driver: ProfileDriver = {
			type: "persistent",
			create: () => ({
				mode: "persistent",
				finished: failed.promise,
				start: () => undefined,
				stop: () => undefined,
			}),
		};
		const app = kernel({ server: "persistent" }, [driver]);
		await app.bootstrap();
		await app.start();

		const exited = app.waitForExit();
		failed.reject(undefined);

		const result = await exited;

		expect(result.status).toBe("failed");
		expect(result.exitCode).toBe(1);
		expect(result.reason).toBe("failure");
		expect("error" in result).toBe(true);
	});

	test("treats unexpected completion of a persistent profile as a failure", async () => {
		const finished = deferred();
		const events: string[] = [];
		const driver: ProfileDriver = {
			type: "persistent",
			create: () => instance("server", finished.promise, "persistent", events),
		};
		const app = kernel({ server: "persistent" }, [driver]);
		await app.bootstrap();
		await app.start();
		const exited = app.waitForExit();
		finished.resolve();

		const result = await exited;

		expect(result.status).toBe("failed");
		expect(result.exitCode).toBe(1);
		expect(result.reason).toBe("failure");
		expect(app.state).toBe("failed");
		expect(events).toEqual(["start:server", "stop:server"]);
	});

	test("a new transport can be added by registering a driver against the existing contract", async () => {
		const done = deferred();
		let created = false;
		const httpDriver: ProfileDriver = {
			type: "http-server",
			create: () => {
				created = true;

				return instance("http", done.promise, "persistent", []);
			},
		};
		const app = kernel({ web: "http-server" }, [httpDriver]);
		await app.bootstrap();
		expect(created).toBe(true);
		await app.start();
		await app.stop();
	});

	test("a startup failure rolls back already-started profiles in reverse order", async () => {
		const events: string[] = [];
		const first: ProfileDriver = {
			type: "first",
			create: () => instance("first", new Promise<void>(() => {}), "persistent", events),
		};
		const second: ProfileDriver = {
			type: "second",
			create: () => ({
				mode: "finite",
				finished: new Promise<void>(() => {}),
				start: () => {
					events.push("start:second");
					throw new Error("startup failure");
				},
				stop: () => {
					events.push("stop:second");
				},
			}),
		};
		const app = kernel({ first: "first", second: "second" }, [first, second]);
		await app.bootstrap();
		await expect(app.start()).rejects.toThrow("startup failure");
		expect(events).toEqual(["start:first", "start:second", "stop:second", "stop:first"]);
		expect(app.state).toBe("failed");
	});
});

function instance(
	id: string,
	finished: Promise<void>,
	mode: "persistent" | "finite",
	events: string[],
	onStop?: () => void,
): ProfileInstance {
	return {
		mode,
		finished,
		start: () => {
			events.push(`start:${id}`);
		},
		stop: () => {
			events.push(`stop:${id}`);
			onStop?.();
		},
	};
}
