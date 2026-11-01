import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkApplication, compileApplication } from "../../src/compiler/index.ts";
import { withTemporaryDirectory } from "../core/helpers.ts";

const valid = `declare const driver: {
	type: string;
	create(): {
		mode: "finite";
		finished: Promise<void>;
		start(signal: AbortSignal): void;
		stop(signal: AbortSignal): void;
	};
};
export default driver;`;

test.each([
	["valid import-only package", valid, true],
	["missing properties", "declare const driver: { name: string }; export default driver;", false],
	["missing default export", "export declare const driver: { type: string };", false],
	[
		"invalid create result",
		"declare const driver: { type: string; create(): number }; export default driver;",
		false,
	],
] as const)(
	"checks package driver declarations without evaluating JavaScript: %s",
	async (_name, declaration, accepted) => {
		await withTemporaryDirectory(async (directory) => {
			const packageDirectory = join(directory, "node_modules/typed-driver");
			await mkdir(packageDirectory, { recursive: true });
			await mkdir(join(directory, "src"));
			await writeFile(join(directory, "src/main.ts"), "export {};");
			await writeFile(
				join(directory, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: { rootDir: "src", strict: true },
					include: ["src"],
				}),
			);
			await writeFile(
				join(packageDirectory, "package.json"),
				JSON.stringify({
					name: "typed-driver",
					type: "module",
					exports: { import: { types: "./index.d.ts", default: "./index.js" } },
				}),
			);
			await writeFile(
				join(packageDirectory, "index.js"),
				'throw new Error("driver evaluated"); export default {};',
			);
			await writeFile(join(packageDirectory, "index.d.ts"), declaration);
			await writeFile(
				join(directory, "framework.toml"),
				'[application]\nprofileDrivers = ["typed-driver"]\n[profiles.job]\ntype = "job"',
			);

			if (!accepted) {
				await expect(checkApplication({ rootDirectory: directory })).rejects.toThrow(
					"Invalid profile driver contract",
				);
				expect(await Bun.file(join(directory, ".norstar/manifest.ts")).exists()).toBe(
					false,
				);

				return;
			}

			await checkApplication({ rootDirectory: directory });
			const { manifestPath } = await compileApplication({ rootDirectory: directory });
			const source = await readFile(manifestPath, "utf8");
			expect(source).toContain("typed-driver/index.js");
			expect(source).not.toContain("index.d.ts");
		});
	},
	20000,
);
