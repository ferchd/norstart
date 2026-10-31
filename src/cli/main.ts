#!/usr/bin/env bun
import { parseArguments } from "./arguments.ts";
import { buildApplication } from "./build.ts";
import { developApplication } from "./watch.ts";
import { checkApplication } from "../compiler/index.ts";
import { reportCliError } from "./diagnostics.ts";
import { initializeApplication } from "./init.ts";

export async function runCli(
	arguments_: readonly string[],
	rootDirectory = process.cwd(),
): Promise<void> {
	const options = parseArguments(arguments_);
	if (options.command === "init") {
		const directory = await initializeApplication(options, rootDirectory);
		console.log(`Created Norstar application in ${directory}`);
		console.log("Run bun install, then bun run dev");

		return;
	}
	if (options.command === "check") {
		await checkApplication({
			rootDirectory,
			configPath: options.configPath,
			entry: options.entry,
		});
		console.log("Application check passed");

		return;
	}
	if (options.command === "build") {
		console.log(`Built ${await buildApplication(options, rootDirectory)}`);

		return;
	}

	await developApplication(options, rootDirectory);
}

if (import.meta.main) {
	try {
		await runCli(process.argv.slice(2));
	} catch (error) {
		reportCliError(error);
		process.exitCode = 1;
	}
}
