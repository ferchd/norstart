import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkApplication, compileApplication } from "../../src/compiler/index.ts";
import { withTemporaryDirectory } from "../core/helpers.ts";

async function createProject(directory: string, source = "export class Store {}") {
	await mkdir(join(directory, "src"));
	await writeFile(join(directory, "framework.toml"), '[profiles.job]\ntype = "worker"');
	await writeFile(join(directory, "src", "store.service.ts"), source);
}

test("rejects semantic service errors before writing an artifact or evaluating code", async () => {
	await withTemporaryDirectory(async (directory) => {
		await createProject(
			directory,
			'throw new Error("must not execute");\nexport class Store { value: string = 123; }',
		);
		for (const operation of [checkApplication, compileApplication]) {
			await expect(operation({ rootDirectory: directory })).rejects.toThrow("TS2322");
		}
		expect(await Bun.file(join(directory, ".norstar", "manifest.ts")).exists()).toBe(false);
	});
}, 20000);

test("checks TypeScript files outside service discovery and their local imports", async () => {
	await withTemporaryDirectory(async (directory) => {
		await createProject(directory);
		await mkdir(join(directory, "helpers"));
		await writeFile(join(directory, "src", "main.ts"), 'import "../helpers/value.ts";');
		await writeFile(join(directory, "helpers", "value.ts"), "export const value: string = 42;");
		await expect(checkApplication({ rootDirectory: directory })).rejects.toThrow(
			"helpers/value.ts(1,14): error TS2322",
		);
	});
}, 20000);

test("honors tsconfig strictness and includes configured application roots", async () => {
	await withTemporaryDirectory(async (directory) => {
		await createProject(directory);
		await mkdir(join(directory, "custom"));
		await writeFile(
			join(directory, "custom", "value.ts"),
			"export const value: string = null;",
		);
		const writeConfig = (strictNullChecks: boolean) =>
			writeFile(
				join(directory, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: { strictNullChecks },
					include: ["custom/**/*.ts"],
				}),
			);
		await writeConfig(false);
		await checkApplication({ rootDirectory: directory });
		await writeConfig(true);
		await expect(checkApplication({ rootDirectory: directory })).rejects.toThrow("TS2322");
	});
}, 20000);

test("resolves service types through tsconfig path aliases", async () => {
	await withTemporaryDirectory(async (directory) => {
		await createProject(directory);
		await writeFile(
			join(directory, "src", "consumer.service.ts"),
			'import { Store } from "@app/store.service.ts";\nexport class Consumer { constructor(readonly store: Store) {} }',
		);
		await writeFile(
			join(directory, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { paths: { "@app/*": ["./src/*"] } },
				include: ["src/**/*.ts"],
			}),
		);
		await checkApplication({ rootDirectory: directory });
		expect(await Bun.file(join(directory, ".norstar", "manifest.ts")).exists()).toBe(false);
	});
}, 20000);

test("reports invalid TypeScript configuration options", async () => {
	await withTemporaryDirectory(async (directory) => {
		await createProject(directory);
		await writeFile(
			join(directory, "tsconfig.json"),
			'{ "compilerOptions": { "strictNulChecks": true } }',
		);
		await expect(checkApplication({ rootDirectory: directory })).rejects.toThrow(
			"Unknown compiler option",
		);
	});
}, 20000);

test("honors explicit TypeScript strict options from an existing tsconfig", async () => {
	await withTemporaryDirectory(async (directory) => {
		await createProject(directory);
		await writeFile(
			join(directory, "src", "helper.ts"),
			"export function echo(value) { return value; }",
		);
		const configPath = join(directory, "tsconfig.json");
		await writeFile(
			configPath,
			JSON.stringify({
				compilerOptions: { types: [], strict: false },
				include: ["src/**/*.ts"],
			}),
		);
		await checkApplication({ rootDirectory: directory });
		await writeFile(
			configPath,
			JSON.stringify({
				compilerOptions: { types: [], strict: true },
				include: ["src/**/*.ts"],
			}),
		);
		await expect(checkApplication({ rootDirectory: directory })).rejects.toThrow("TS7006");
	});
}, 20000);

test("checks imported shared application sources outside the project directory", async () => {
	await withTemporaryDirectory(async (directory) => {
		const app = join(directory, "app");
		await mkdir(app);
		await createProject(app);
		await mkdir(join(directory, "shared"));
		await writeFile(join(directory, "shared", "value.ts"), "export const value: string = 123;");
		await writeFile(join(app, "src", "main.ts"), 'import "../../shared/value.ts";');
		await expect(checkApplication({ rootDirectory: app })).rejects.toThrow(
			"shared/value.ts(1,14): error TS2322",
		);
	});
}, 20000);

test("rejects explicit injection implementations incompatible with constructor types", async () => {
	await withTemporaryDirectory(async (directory) => {
		await createProject(
			directory,
			'export class Store { value = "store"; }\nexport class Other { other = true; }\nexport class Consumer { static norstarService = { lifetime: "transient", inject: [Other] }; constructor(readonly store: Store) {} }',
		);
		await expect(checkApplication({ rootDirectory: directory })).rejects.toThrow(
			"Service dependency type mismatch",
		);
	});
}, 20000);
