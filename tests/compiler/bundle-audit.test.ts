import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertNoStaticThirdPartyDependencies,
	auditBundleDependencies,
} from "../../src/compiler/bundle-audit.ts";
import { withTemporaryDirectory } from "../core/helpers.ts";
import { buildApplication } from "../../src/cli/build.ts";

async function bundle(entry: string, outdir: string, external: string[] = []) {
	const result = await Bun.build({
		entrypoints: [entry],
		outdir,
		target: "bun",
		metafile: true,
		external,
	});
	if (!result.success || !result.metafile) {
		throw new Error(`Bundle failed: ${result.logs.join("\n")}`);
	}

	return result;
}

async function execute(entry: string, directory: string) {
	const child = Bun.spawn([process.execPath, entry], {
		cwd: directory,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);

	return { code, stdout, stderr };
}

test("official runtime and SQL query exports bundle without npm dependencies", async () => {
	await withTemporaryDirectory(async (directory) => {
		const inputs = join(directory, "inputs");
		const runtime = join(directory, "runtime");
		await Promise.all([mkdir(inputs), mkdir(runtime)]);
		const modules = [
			"core/index.ts",
			"http/index.ts",
			"sql/index.ts",
			"query/index.ts",
			"index.ts",
		].map((path) =>
			fileURLToPath(new URL(`../../src/${path}`, import.meta.url)).replaceAll("\\", "/"),
		);
		const entry = join(inputs, "main.ts");
		await writeFile(
			entry,
			`import * as Core from ${JSON.stringify(modules[0])};
import * as Http from ${JSON.stringify(modules[1])};
import * as Sql from ${JSON.stringify(modules[2])};
import * as Query from ${JSON.stringify(modules[3])};
import * as Norstar from ${JSON.stringify(modules[4])};
const query = Query.selectQuery({
	from: { name: Query.identifier("users") },
	columns: [{ expression: Query.column("id") }],
	where: Query.compare("eq", Query.column("name"), Sql.parameter("text", "Ada")),
});
console.log(JSON.stringify(Query.compileQuery(query, "postgresql")));
console.log(JSON.stringify([Object.keys(Core), Object.keys(Http), Object.keys(Sql), Object.keys(Query), Object.keys(Norstar)]));
`,
		);
		const result = await bundle(entry, runtime);
		const report = await auditBundleDependencies(result, { rootDirectory: inputs });

		expect(report.thirdPartyInputs).toEqual([]);
		expect(report.externalPackages).toEqual([]);
		expect(report.externalFiles).toEqual([]);
		// Retaining all runtime exports includes the optional service-module and HTTP route loaders.
		// Their two configuration-driven imports are reviewed separately from the static graph.
		expect(report.unresolvedDynamicImports).toBe(2);
		expect(() => assertNoStaticThirdPartyDependencies(report)).not.toThrow();
		expect(Object.isFrozen(report.nativeImports)).toBe(true);
		await rm(inputs, { recursive: true });
		expect(await readdir(runtime)).toEqual(["main.js"]);
		const execution = await execute(join(runtime, "main.js"), runtime);
		expect(execution.code).toBe(0);
		expect(execution.stderr).toBe("");
		expect(execution.stdout).toContain('"value":"Ada"');
		expect(execution.stdout).toContain("$1");
	});
}, 20000);

test("detects an embedded dependency even when it runs without its original package", async () => {
	await withTemporaryDirectory(async (directory) => {
		const inputs = join(directory, "inputs");
		const runtime = join(directory, "runtime");
		const dependency = join(inputs, "node_modules/norstar");
		await mkdir(dependency, { recursive: true });
		await mkdir(runtime);
		await writeFile(join(inputs, "package.json"), '{"name":"audit-fixture","private":true}');
		await writeFile(
			join(dependency, "package.json"),
			'{"name":"norstar","type":"module","exports":"./index.js"}',
		);
		await writeFile(
			join(dependency, "index.js"),
			'export const message = "embedded dependency";',
		);
		const entry = join(inputs, "main.ts");
		await writeFile(entry, 'import { message } from "norstar"; console.log(message);');
		const result = await bundle(entry, runtime);
		const report = await auditBundleDependencies(result, { rootDirectory: inputs });

		expect(report.thirdPartyInputs).toHaveLength(1);
		expect(report.thirdPartyInputs[0]?.path).toContain("node_modules/norstar/index.js");
		expect(() => assertNoStaticThirdPartyDependencies(report)).toThrow(
			"third-party dependencies",
		);
		await rm(inputs, { recursive: true });
		const execution = await execute(join(runtime, "main.js"), runtime);
		expect(execution.code).toBe(0);
		expect(execution.stdout.trim()).toBe("embedded dependency");
	});
});

test("reports external npm imports and allows known native modules", async () => {
	await withTemporaryDirectory(async (directory) => {
		const entry = join(directory, "main.ts");
		await writeFile(
			entry,
			'import { join } from "node:path"; import { Database } from "bun:sqlite"; import { value } from "external-package"; console.log(join("a", "b"), Database, value);',
		);
		const result = await bundle(entry, join(directory, "dist"), ["external-package"]);
		const report = await auditBundleDependencies(result, { rootDirectory: directory });

		expect(report.thirdPartyInputs).toEqual([]);
		expect(report.externalPackages).toEqual(["external-package"]);
		expect(report.nativeImports).toEqual(["bun:sqlite", "node:path"]);
		expect(() => assertNoStaticThirdPartyDependencies(report)).toThrow("external-package");
	});
});

test("detects a dependency externalized through a relative filesystem path", async () => {
	await withTemporaryDirectory(async (directory) => {
		const dependency = join(directory, "node_modules/fixture-dependency");
		await mkdir(dependency, { recursive: true });
		await writeFile(join(dependency, "index.js"), "export const value = 1;");
		const entry = join(directory, "main.ts");
		await writeFile(
			entry,
			'import { value } from "./node_modules/fixture-dependency/index.js"; console.log(value);',
		);
		const result = await bundle(entry, join(directory, "dist"), [join(dependency, "index.js")]);
		const report = await auditBundleDependencies(result, { rootDirectory: directory });

		expect(report.externalFiles).toHaveLength(1);
		expect(() => assertNoStaticThirdPartyDependencies(report)).toThrow("fixture-dependency");
	});
});

test("does not count a dependency removed from the emitted artifact", async () => {
	await withTemporaryDirectory(async (directory) => {
		const dependency = join(directory, "node_modules/unused-package");
		await mkdir(dependency, { recursive: true });
		await writeFile(
			join(dependency, "package.json"),
			'{"name":"unused-package","type":"module","sideEffects":false,"exports":"./index.js"}',
		);
		await writeFile(join(dependency, "index.js"), 'export const unused = "not retained";');
		const entry = join(directory, "main.ts");
		await writeFile(entry, 'import { unused } from "unused-package"; console.log("entry");');
		const result = await bundle(entry, join(directory, "dist"));
		const report = await auditBundleDependencies(result, { rootDirectory: directory });

		expect(report.thirdPartyInputs).toEqual([]);
		expect(() => assertNoStaticThirdPartyDependencies(report)).not.toThrow();
		expect(await readFile(join(directory, "dist/main.js"), "utf8")).not.toContain(
			"not retained",
		);
	});
});

test("detects CommonJS external requires after Bun rewrites their aliases", async () => {
	await withTemporaryDirectory(async (directory) => {
		const entry = join(directory, "main.cjs");
		await writeFile(
			entry,
			'const dependency = require("external-commonjs"); console.log(dependency);',
		);
		const result = await bundle(entry, join(directory, "dist"), ["external-commonjs"]);
		const report = await auditBundleDependencies(result, { rootDirectory: directory });

		expect(report.externalPackages).toEqual(["external-commonjs"]);
		expect(() => assertNoStaticThirdPartyDependencies(report)).toThrow("external-commonjs");
	});
});

test("preserves package provenance when node_modules links to an application-local vendor folder", async () => {
	await withTemporaryDirectory(async (directory) => {
		const vendor = join(directory, "vendor/local-dependency");
		const modules = join(directory, "node_modules");
		await mkdir(vendor, { recursive: true });
		await mkdir(modules);
		await writeFile(join(vendor, "index.js"), 'export const value = "linked package";');
		await symlink(
			vendor,
			join(modules, "linked-package"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const entry = join(directory, "main.ts");
		await writeFile(entry, 'import { value } from "linked-package"; console.log(value);');
		const result = await bundle(entry, join(directory, "dist"));
		const report = await auditBundleDependencies(result, { rootDirectory: directory });

		expect(report.thirdPartyInputs).toHaveLength(1);
		expect(() => assertNoStaticThirdPartyDependencies(report)).toThrow(
			"third-party dependencies",
		);
	});
});

test("detects a retained require assigned to a previously declared alias", async () => {
	await withTemporaryDirectory(async (directory) => {
		const entry = join(directory, "main.cjs");
		await writeFile(entry, 'let load; load = require; console.log(load("assigned-package"));');
		const result = await bundle(entry, join(directory, "dist"), ["assigned-package"]);
		const report = await auditBundleDependencies(result, { rootDirectory: directory });

		expect(report.externalPackages).toEqual(["assigned-package"]);
		expect(() => assertNoStaticThirdPartyDependencies(report)).toThrow("assigned-package");
	});
});

test("distinguishes real require aliases from shadowing callback parameters", async () => {
	await withTemporaryDirectory(async (directory) => {
		const entry = join(directory, "main.cjs");
		await writeFile(
			entry,
			`const loader = require;
function local(loader) {
	return loader("callback-argument");
}
function shadow(require) {
	return require("local-require-argument");
}
function nested() {
	const loader = (value) => value;
	return loader("block-local-argument");
}
console.log(local((value) => value), shadow((value) => value), nested());
console.log(loader("real-package"));`,
		);
		const result = await bundle(entry, join(directory, "dist"), ["real-package"]);
		const report = await auditBundleDependencies(result, { rootDirectory: directory });

		expect(report.externalPackages).toEqual(["real-package"]);
		expect(report.unresolvedDynamicImports).toBe(0);
	});
});

test("CLI builds report chosen third-party dependencies without banning user integrations", async () => {
	const directory = await mkdtemp(join(process.cwd(), ".norstar-cli-test-audit-"));
	try {
		await mkdir(join(directory, "src"));
		const dependency = join(directory, "node_modules/fixture-dependency");
		await mkdir(dependency, { recursive: true });
		await writeFile(
			join(dependency, "package.json"),
			'{"name":"fixture-dependency","type":"module","exports":"./index.js"}',
		);
		await writeFile(join(dependency, "index.js"), 'export const value = "user integration";');
		await writeFile(join(dependency, "index.d.ts"), "export declare const value: string;");
		await writeFile(
			join(directory, "src/main.ts"),
			'import { value } from "fixture-dependency"; console.log(value);',
		);
		await writeFile(join(directory, "framework.toml"), '[profiles.job]\ntype = "job"');
		const output = await buildApplication(
			{
				command: "build",
				configPath: "framework.toml",
				entry: "src/main.ts",
				outdir: "dist",
			},
			directory,
		);
		const report = await Bun.file(join(directory, ".norstar/dependencies.json")).json();

		expect(await Bun.file(output).exists()).toBe(true);
		expect(report.thirdPartyInputs).toHaveLength(1);
		expect(report.thirdPartyInputs[0].path).toContain("fixture-dependency");
		expect(() => assertNoStaticThirdPartyDependencies(report)).toThrow("fixture-dependency");
	} finally {
		await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}, 20000);
