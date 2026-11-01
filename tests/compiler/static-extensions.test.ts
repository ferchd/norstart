import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkApplication, compileApplication } from "../../src/compiler/index.ts";
import { buildApplication } from "../../src/cli/build.ts";
import { withTemporaryDirectory } from "../core/helpers.ts";

const database = `export class Database {
	text = "static extension database";
}`;
const consumer = `import { DATABASE } from "./tokens.ts";
import { Database } from "./database.extension.ts";
export class Consumer {
	static norstarService = { lifetime: "transient", inject: [DATABASE] };
	constructor(readonly database: Database) {}
}`;

async function fixture(
	directory: string,
	implementation = database,
	application = consumer,
	metadata?: string,
): Promise<void> {
	await mkdir(join(directory, "src"));
	await writeFile(
		join(directory, "framework.toml"),
		'[application]\nextensions = ["./src/database.extension.ts"]\n[profiles.job]\ntype = "job"',
	);
	await writeFile(
		join(directory, "src/tokens.ts"),
		'export const DATABASE = Symbol("database");',
	);
	await writeFile(join(directory, "src/consumer.service.ts"), application);
	await writeFile(
		join(directory, "src/database.extension.ts"),
		`import { DATABASE } from "./tokens.ts";
${implementation}
export default {
	name: "database",
	providers: ${metadata ?? '[{ token: DATABASE, useClass: Database, inject: [], lifetime: "singleton" }]'},
	register() {
		throw new Error("compiler evaluated register");
	},
};`,
	);
}

test("combines static extension providers with discovered consumers without evaluation", async () => {
	await withTemporaryDirectory(async (directory) => {
		await fixture(directory);
		const path = join(directory, "src/database.extension.ts");
		await writeFile(
			path,
			`throw new Error("compiler evaluated extension");\n${await readFile(path, "utf8")}`,
		);

		await checkApplication({ rootDirectory: directory });
		expect(await Bun.file(join(directory, ".norstar/manifest.ts")).exists()).toBe(false);
		const { manifestPath } = await compileApplication({ rootDirectory: directory });
		expect(await Bun.file(manifestPath).exists()).toBe(true);
	});
}, 20000);

test("preserves semantic checks for a user file matching the virtual import name", async () => {
	await withTemporaryDirectory(async (directory) => {
		await fixture(directory);
		await writeFile(
			join(directory, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { rootDir: "src" }, include: ["src/**/*.ts"] }),
		);
		await writeFile(
			join(directory, "src/__norstar_extension_imports__.ts"),
			"export const broken: string = 123;",
		);

		await expect(checkApplication({ rootDirectory: directory })).rejects.toThrow("TS2322");
	});
}, 20000);

test("checks an installed extension source package with application rootDir src", async () => {
	await withTemporaryDirectory(async (directory) => {
		await mkdir(join(directory, "src"));
		const packageDirectory = join(directory, "node_modules/external-extension");
		await mkdir(packageDirectory, { recursive: true });
		await writeFile(
			join(packageDirectory, "package.json"),
			JSON.stringify({ name: "external-extension", type: "module", exports: "./index.ts" }),
		);
		await writeFile(
			join(packageDirectory, "index.ts"),
			`export const DATABASE = Symbol("database");
export class Database {
	text = "external provider";
}
export default {
	name: "external",
	providers: [{ token: DATABASE, useClass: Database, inject: [], lifetime: "singleton" }],
};`,
		);
		await writeFile(
			join(directory, "src/consumer.service.ts"),
			`import { DATABASE, Database } from "external-extension";
export class Consumer {
	static norstarService = { lifetime: "transient", inject: [DATABASE] };
	constructor(readonly database: Database) {}
}`,
		);
		await writeFile(
			join(directory, "framework.toml"),
			'[application]\nextensions = ["external-extension"]\n[profiles.job]\ntype = "job"',
		);
		await writeFile(
			join(directory, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { rootDir: "src" }, include: ["src/**/*.ts"] }),
		);

		await checkApplication({ rootDirectory: directory });
		const { manifestPath } = await compileApplication({ rootDirectory: directory });
		expect(await Bun.file(manifestPath).text()).toContain("external-extension/index.ts");
	});
}, 20000);

test.each([
	[
		"missing provider dependency",
		`export class Missing {}
export class Database {
	constructor(readonly missing: Missing) {}
}`,
		consumer,
		'[{ token: DATABASE, useClass: Database, inject: [Missing], lifetime: "singleton" }]',
		"Missing service dependency",
	],
	[
		"duplicate token across extension and discovery",
		database,
		consumer.replace(
			'lifetime: "transient", inject: [DATABASE]',
			'lifetime: "transient", inject: [DATABASE], token: DATABASE',
		),
		undefined,
		"Duplicate service token",
	],
	[
		"cycle across extension and discovery",
		`import { Consumer } from "./consumer.service.ts";
export class Database {
	constructor(readonly consumer: Consumer) {}
}`,
		consumer,
		'[{ token: DATABASE, useClass: Database, inject: [Consumer], lifetime: "transient" }]',
		"Circular service dependency",
	],
	[
		"singleton extension depending on scoped consumer",
		`import { Consumer } from "./consumer.service.ts";
export class Database {
	constructor(readonly consumer: Consumer) {}
}`,
		'export class Consumer {\nstatic norstarService = { lifetime: "scoped", inject: [] };\n}',
		'[{ token: DATABASE, useClass: Database, inject: [Consumer], lifetime: "singleton" }]',
		"Singleton cannot depend on scoped service",
	],
] as const)(
	"rejects %s in the combined graph",
	async (_name, implementation, application, metadata, diagnostic) => {
		await withTemporaryDirectory(async (directory) => {
			await fixture(directory, implementation, application, metadata);
			await expect(checkApplication({ rootDirectory: directory })).rejects.toThrow(
				diagnostic,
			);
			expect(await Bun.file(join(directory, ".norstar/manifest.ts")).exists()).toBe(false);
		});
	},
	20000,
);

test("rejects dynamic provider metadata without calling its factory", async () => {
	await withTemporaryDirectory(async (directory) => {
		await fixture(
			directory,
			`${database}
function getProviders() {
	throw new Error("provider factory executed");
}`,
			consumer,
			"getProviders()",
		);
		await expect(checkApplication({ rootDirectory: directory })).rejects.toThrow(
			"Compiled extension providers must be a static array",
		);
		expect(await Bun.file(join(directory, ".norstar/manifest.ts")).exists()).toBe(false);
	});
}, 20000);

test("runs a compiled discovered consumer using extension providers after removing sources", async () => {
	const directory = await mkdtemp(join(process.cwd(), ".norstar-cli-test-static-extensions-"));
	try {
		await fixture(directory);
		await writeFile(
			join(directory, "src/database.extension.ts"),
			`import { DATABASE } from "./tokens.ts";
export class Database {
	text = "static extension database";
	dispose() {
		console.log("database disposed");
	}
}
export default {
	name: "database",
	providers: [{ token: DATABASE, useClass: Database, inject: [], lifetime: "singleton" }],
	initialize() {
		console.log("extension initialized");
	},
	shutdown() {
		console.log("extension stopped");
	},
};`,
		);
		await writeFile(
			join(directory, "src/main.ts"),
			`import { Application } from "norstar";
import { Consumer } from "./consumer.service.ts";
await Application.configure({
	drivers: [{
		type: "job",
		create({ services }) {
			return {
				mode: "finite",
				finished: Promise.resolve(),
				start() {
					console.log(services.get(Consumer).database.text);
				},
				stop() {
					console.log("profile stopped");
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
			"extension initialized",
			"static extension database",
			"profile stopped",
			"extension stopped",
			"database disposed",
		]);
	} finally {
		await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}, 30000);
