#!/usr/bin/env bun
import { parseArguments } from "./arguments.ts";
import { buildApplication } from "./build.ts";
import { developApplication } from "./watch.ts";
import { checkApplication } from "../compiler/index.ts";

export async function runCli(
	arguments_: readonly string[],
	rootDirectory = process.cwd(),
): Promise<void> {
	const options = parseArguments(arguments_);
	if (options.command === "check") {
		await checkApplication({ rootDirectory, configPath: options.configPath });
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
		console.error(error);
		process.exitCode = 1;
	}
}
