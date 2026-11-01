import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Application } from "../../src/core/application.ts";
import { parseConfiguration } from "../../src/core/configuration.ts";
import type { ApplicationExtension, ExtensionProvider } from "../../src/core/extensions.ts";
import { withTemporaryDirectory } from "./helpers.ts";

async function config(directory: string): Promise<string> {
	const path = join(directory, "framework.toml");
	await writeFile(path, '[profiles.job]\ntype = "job"');

	return path;
}

test("extension providers share singleton dependencies and dispose after lifecycle hooks", async () => {
	await withTemporaryDirectory(async (directory) => {
		const events: string[] = [];
		const DATABASE = Symbol("database");
		class Database {
			constructor() {
				events.push("database:create");
			}
			dispose() {
				events.push("database:dispose");
			}
		}
		class Client {
			constructor(readonly database: Database) {}
			dispose() {
				events.push("client:dispose");
			}
		}
		let resolved: Client | undefined;
		const clientInjection = [DATABASE];
		const extension: ApplicationExtension = {
			name: "database",
			providers: [
				{ token: DATABASE, useClass: Database, inject: [], lifetime: "singleton" },
				{ token: Client, useClass: Client, inject: clientInjection, lifetime: "singleton" },
			],
			initialize({ services }) {
				resolved = services.get(Client);
				expect(resolved.database).toBe(services.get(DATABASE));
				events.push("initialize");
			},
			shutdown({ services }) {
				if (resolved === undefined) {
					throw new Error("Extension client was not initialized");
				}
				expect(services.get(Client)).toBe(resolved);
				events.push("shutdown");
			},
		};
		const app = Application.configure({
			configPath: await config(directory),
			handleProcessSignals: false,
			extensions: [extension],
			drivers: [
				{
					type: "job",
					create({ services }) {
						return {
							mode: "finite",
							finished: Promise.resolve(),
							start() {
								if (resolved === undefined) {
									throw new Error("Extension client was not initialized");
								}
								expect(services.get(Client)).toBe(resolved);
								events.push("profile:start");
							},
							stop() {
								events.push("profile:stop");
							},
						};
					},
				},
			],
		}).create();
		clientInjection.length = 0;

		expect(events).toEqual([]);
		expect((await app.run()).status).toBe("completed");
		expect(events).toEqual([
			"database:create",
			"initialize",
			"profile:start",
			"profile:stop",
			"shutdown",
			"client:dispose",
			"database:dispose",
		]);
	});
});

test("validates and freezes configured extension module specifiers", () => {
	const config = parseConfiguration(
		'[application]\nextensions = ["./src/database.extension.ts"]\n[profiles.job]\ntype = "job"',
	);

	expect(config.application.extensions).toEqual(["./src/database.extension.ts"]);
	expect(Object.isFrozen(config.application.extensions)).toBe(true);
	expect(parseConfiguration('[profiles.job]\ntype = "job"').application.extensions).toEqual([]);
	expect(() =>
		parseConfiguration('[application]\nextensions = "database"\n[profiles.job]\ntype = "job"'),
	).toThrow("must be an array");
	expect(() =>
		parseConfiguration('[application]\nextensions = [""]\n[profiles.job]\ntype = "job"'),
	).toThrow("must be a non-empty module specifier");
});

test.each([
	{ token: Symbol("bad"), useClass: 1, inject: [], lifetime: "singleton" },
	{ token: "bad", useClass: class {}, inject: [], lifetime: "singleton" },
	{ token: Symbol("bad"), useClass: class {}, inject: ["bad"], lifetime: "singleton" },
	{ token: Symbol("bad"), useClass: class {}, inject: [], lifetime: "invalid" },
])("rejects invalid provider metadata before register hooks", async (provider) => {
	await withTemporaryDirectory(async (directory) => {
		let registered = false;
		await config(directory);
		expect(() =>
			Application.configure({
				configPath: join(directory, "framework.toml"),
				extensions: [
					{
						name: "invalid",
						providers: [provider as unknown as ExtensionProvider],
						register() {
							registered = true;
						},
					},
				],
			}).create(),
		).toThrow("Invalid extension provider");
		expect(registered).toBe(false);
	});
});

test("rejects duplicate provider tokens across extensions before registration", async () => {
	await withTemporaryDirectory(async (directory) => {
		const token = Symbol("duplicate");
		class Service {}
		const provider: ExtensionProvider = {
			token,
			useClass: Service,
			inject: [],
			lifetime: "singleton",
		};
		let hooks = 0;
		const extension = (name: string): ApplicationExtension => ({
			name,
			providers: [provider],
			register() {
				hooks++;
			},
		});
		await config(directory);
		expect(() =>
			Application.configure({
				configPath: join(directory, "framework.toml"),
				extensions: [extension("one"), extension("two")],
			}).create(),
		).toThrow("Duplicate extension provider token");
		expect(hooks).toBe(0);
	});
});
