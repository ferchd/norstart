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
