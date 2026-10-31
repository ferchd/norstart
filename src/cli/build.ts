import { writeFile } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { CliOptions } from "./arguments.ts";
import { compileApplication } from "../compiler/index.ts";

function importPath(from: string, target: string): string {
	const path = relative(dirname(from), target).replaceAll("\\", "/");

	return path.startsWith(".") ? path : `./${path}`;
}

export async function buildApplication(
	options: CliOptions,
	rootDirectory: string,
): Promise<string> {
	const entry = resolve(rootDirectory, options.entry);
	const outputDirectory = resolve(rootDirectory, options.outdir);
	const entryRelativeToOutput = relative(outputDirectory, entry);
	if (
		!entryRelativeToOutput.startsWith(`..${sep}`) &&
		entryRelativeToOutput !== ".." &&
		!isAbsolute(entryRelativeToOutput)
	) {
		throw new Error("The output directory must not contain the application source entry");
	}

	const manifest = await compileApplication({
		rootDirectory,
		configPath: options.configPath,
	});
	const bootstrap = resolve(dirname(manifest.manifestPath), "bootstrap.ts");
	if (entry === bootstrap) {
		throw new Error("The application entry must not be the generated bootstrap");
	}

	await writeFile(
		bootstrap,
		`import definition from ${JSON.stringify(importPath(bootstrap, manifest.manifestPath))};\nimport { setCompiledApplication } from "norstar/core";\nsetCompiledApplication(definition);\nawait import(${JSON.stringify(importPath(bootstrap, entry))});\n`,
	);
	const result = await Bun.build({
		entrypoints: [bootstrap],
		outdir: outputDirectory,
		naming: `${parse(entry).name}.js`,
		target: "bun",
	});
	if (!result.success) {
		throw new AggregateError(result.logs, "Application build failed");
	}

	const output = result.outputs.find((artifact) => artifact.kind === "entry-point");
	if (!output) {
		throw new Error("Application build did not emit an entry point");
	}

	return output.path;
}
