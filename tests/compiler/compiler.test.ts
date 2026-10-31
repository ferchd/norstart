import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkApplication, compileApplication } from "../../src/compiler/index.ts";
import { withTemporaryDirectory } from "../core/helpers.ts";

async function fixture(directory: string, services: string, discovery?: string[]): Promise<void> {
	await mkdir(join(directory, "src"));
	await writeFile(join(directory, "src", "example.service.ts"), services);
	await writeFile(
		join(directory, "framework.toml"),
		`${discovery ? `[application]\ndiscovery = ${JSON.stringify(discovery)}\n` : ""}[profiles.job]\ntype = "worker"\n`,
	);
}

describe("static application compiler", () => {
	test("reports a missing declared profile driver module", async () => {
		await withTemporaryDirectory(async (directory) => {
			await fixture(directory, "export class Store {}");
			await writeFile(
				join(directory, "framework.toml"),
				'[application]\nprofileDrivers = ["missing-profile-driver"]\n\n[profiles.job]\ntype = "worker"',
			);

			await expect(checkApplication({ rootDirectory: directory })).rejects.toThrow(
				"Profile driver module not found: missing-profile-driver",
			);
		});
	}, 20000);

	test("discovers constructor dependencies without evaluating modules or writing artifacts during check", async () => {
		await withTemporaryDirectory(async (directory) => {
			await fixture(
				directory,
				`throw new Error("discovery executed application code");
export class Store {}
export class Service {
	constructor(readonly store: Store) {}
}
`,
			);
			await checkApplication({ rootDirectory: directory });
			expect(await Bun.file(join(directory, ".norstar", "manifest.ts")).exists()).toBe(false);
			const { manifestPath } = await compileApplication({ rootDirectory: directory });
			const generated = await readFile(manifestPath, "utf8");
			expect(generated).toContain('import * as module0 from "../src/example.service.ts"');
			expect(generated).toContain('resolver.get(module0["Store"])');
			expect(generated).not.toContain("import(");
			expect(generated).not.toContain("Bun.Glob");
			expect(generated).toContain("\tconfig: Object.freeze({\n\t\t");
			expect(generated).toContain("\tregisterServices(services) {\n\t\tservices.register(\n");
		});
	}, 20000);

	test.each([
		[
			"missing dependency",
			'export class Missing {}\nexport class Service { static norstarService = {lifetime: "transient", inject: [Unregistered]}; constructor(readonly dependency: Unregistered) {} }\nclass Unregistered {}',
			"Missing service dependency",
		],
		[
			"circular dependency",
			"export class A { constructor(readonly b: B) {} }\nexport class B { constructor(readonly a: A) {} }",
			"Circular service dependency",
		],
		[
			"transitive scoped dependency",
			'export class A { static norstarService = {lifetime: "singleton", inject: [B]}; constructor(readonly dependency: B) {} }\nexport class B { static norstarService = {lifetime: "transient", inject: [C]}; constructor(readonly dependency: C) {} }\nexport class C { static norstarService = {lifetime: "scoped", inject: []}; }',
			"Singleton cannot depend on scoped service",
		],
		[
			"dynamic metadata",
			"export class A { static norstarService = getMetadata(); }\ndeclare function getMetadata(): unknown;",
			"static literal",
		],
		[
			"duplicate token",
			'export const TOKEN = Symbol("token");\nexport class A { static norstarService = {lifetime: "transient", inject: [], token: TOKEN}; }\nexport class B { static norstarService = {lifetime: "transient", inject: [], token: TOKEN}; }',
			"Duplicate service token",
		],
	] as const)(
		"rejects %s before execution",
		async (_name, source, message) => {
			await withTemporaryDirectory(async (directory) => {
				await fixture(directory, source);
				await expect(checkApplication({ rootDirectory: directory })).rejects.toThrow(
					message,
				);
			});
		},
		20000,
	);

	test("resolves imported aliases to exported symbol tokens", async () => {
		await withTemporaryDirectory(async (directory) => {
			await fixture(
				directory,
				`import { TOKEN as STORE } from "./tokens.ts";
export class Store { static norstarService = {lifetime: "singleton", inject: [], token: STORE}; }
export class Controller { static norstarService = {lifetime: "scoped", inject: [STORE]}; constructor(readonly store: Store) {} }
`,
			);
			await writeFile(
				join(directory, "src", "tokens.ts"),
				'export const TOKEN = Symbol("store");',
			);
			const { manifestPath } = await compileApplication({ rootDirectory: directory });
			const generated = await readFile(manifestPath, "utf8");
			expect(generated).toContain('module1["TOKEN"]');
			expect(generated).toContain('"../src/tokens.ts"');
		});
	}, 20000);

	test("honors configurable discovery globs", async () => {
		await withTemporaryDirectory(async (directory) => {
			await fixture(directory, "export class Ignored {}", ["custom/**/*.ts"]);
			await mkdir(join(directory, "custom"));
			await writeFile(join(directory, "custom", "services.ts"), "export class Discovered {}");
			const { manifestPath } = await compileApplication({ rootDirectory: directory });
			const generated = await readFile(manifestPath, "utf8");
			expect(generated).toContain('module0["Discovered"]');
			expect(generated).not.toContain("Ignored");
		});
	}, 20000);
});

test("generates executable factories and immutable runtime metadata", async () => {
	await withTemporaryDirectory(async (directory) => {
		await fixture(
			directory,
			"export class Store {}\nexport class Service { constructor(readonly store: Store) {} }",
		);
		const { manifestPath } = await compileApplication({ rootDirectory: directory });
		const { default: definition } = await import(manifestPath);
		expect(Object.isFrozen(definition.config)).toBe(true);
		expect(Object.isFrozen(definition.config.profiles)).toBe(true);
		expect(Object.isFrozen(definition.manifest.profiles)).toBe(true);
		const registered: unknown[] = [];
		definition.registerServices({
			register: (
				token: unknown,
				factory: (resolver: { get(token: unknown): unknown }) => unknown,
			) => registered.push({ token, factory }),
		});
		expect(registered).toHaveLength(2);
	});
}, 20000);

test.each([false, true])(
	"rejects top-level await in route dependency graph (transitive: %s)",
	async (transitive) => {
		await withTemporaryDirectory(async (directory) => {
			await fixture(directory, "export class Store {}");
			await writeFile(
				join(directory, "src", "first.ts"),
				transitive ? 'import "./dependency.ts";' : "await Promise.resolve();",
			);
			await writeFile(join(directory, "src", "dependency.ts"), "await Promise.resolve();");
			await writeFile(join(directory, "src", "second.ts"), "export {};");
			await writeFile(
				join(directory, "framework.toml"),
				'[profiles.http]\ntype = "http-server"\n[profiles.http.routes]\nfirst = "src/first.ts"\nsecond = "src/second.ts"',
			);
			await expect(checkApplication({ rootDirectory: directory })).rejects.toThrow(
				"top-level await",
			);
			await expect(compileApplication({ rootDirectory: directory })).rejects.toThrow(
				"top-level await",
			);
		});
	},
	20000,
);

test.each([
	["export class Base {}\nexport class Child extends Base {}", "without inheritance"],
	[
		'export class Store {}\nexport class Service { static norstarService = { lifetime: "transient", inject: [Store] }; }',
		"dependency count",
	],
	[
		'export class Store {}\nexport class Service { static norstarService = {lifetime: "transient", inject: []}; constructor(readonly store: Store) {} }',
		"dependency count",
	],
	[
		'export const TOKEN = 123; export class Service { static norstarService = {lifetime: "transient", inject: [], token: TOKEN}; }',
		"exported Symbol()",
	],
	[
		'export const TOKEN = Symbol("shared"); const ALIAS = TOKEN; export class A { static norstarService = {lifetime: "transient", inject: [], token: TOKEN}; } export class B { static norstarService = {lifetime: "transient", inject: [], token: ALIAS}; }',
		"Duplicate service token",
	],
] as const)(
	"rejects unsupported static service shape",
	async (source, message) => {
		await withTemporaryDirectory(async (directory) => {
			await fixture(directory, source);
			await expect(checkApplication({ rootDirectory: directory })).rejects.toThrow(message);
		});
	},
	20000,
);

test("validates route modules during check without generating files", async () => {
	await withTemporaryDirectory(async (directory) => {
		await fixture(directory, "export class Store {}");
		await writeFile(
			join(directory, "framework.toml"),
			'[profiles.http]\ntype = "http-server"\n[profiles.http.routes]\napi = "missing.ts"',
		);
		await expect(checkApplication({ rootDirectory: directory })).rejects.toThrow(
			"HTTP route module not found",
		);
	});
}, 20000);

test("rejects TOML datetime rather than changing its runtime type", async () => {
	await withTemporaryDirectory(async (directory) => {
		await fixture(directory, "export class Store {}");
		await writeFile(
			join(directory, "framework.toml"),
			'[profiles.job]\ntype = "worker"\ndate = 2026-10-31T00:00:00Z',
		);
		await expect(checkApplication({ rootDirectory: directory })).rejects.toThrow(
			"TOML dates are unsupported",
		);
	});
}, 20000);
