export interface ApplicationCliOptions {
	readonly command: "check" | "build" | "dev";
	readonly configPath: string;
	readonly entry: string;
	readonly outdir: string;
}

export interface InitCliOptions {
	readonly command: "init";
	readonly directory: string;
	readonly framework?: string;
}

export type CliOptions = ApplicationCliOptions | InitCliOptions;

export function parseArguments(arguments_: readonly string[]): CliOptions {
	const [command, ...rest] = arguments_;
	if (command === "init") {
		return parseInitArguments(rest);
	}
	if (command !== "check" && command !== "build" && command !== "dev") {
		throw new Error("Usage: norstar <init|check|build|dev> [options]");
	}

	const options = { command, configPath: "framework.toml", entry: "src/main.ts", outdir: "dist" };
	const seen = new Set<string>();
	for (let index = 0; index < rest.length; index += 2) {
		const flag = rest[index];
		const value = rest[index + 1];
		if (flag !== "--config" && flag !== "--entry" && flag !== "--outdir") {
			throw new Error(`Unknown option: ${flag}`);
		}
		if (!value || value.startsWith("--")) {
			throw new Error(`Missing value for ${flag}`);
		}
		if (seen.has(flag)) {
			throw new Error(`Duplicate option: ${flag}`);
		}

		seen.add(flag);
		if (flag === "--config") {
			options.configPath = value;
		} else if (flag === "--entry") {
			options.entry = value;
		} else {
			options.outdir = value;
		}
	}

	return options as CliOptions;
}

function parseInitArguments(arguments_: readonly string[]): InitCliOptions {
	let directory = ".";
	let framework: string | undefined;
	let directorySet = false;
	for (let index = 0; index < arguments_.length; index++) {
		const argument = arguments_[index];
		if (argument === "--framework") {
			const value = arguments_[index + 1];
			if (!value || value.startsWith("--")) {
				throw new Error("Missing value for --framework");
			}
			if (framework !== undefined) {
				throw new Error("Duplicate option: --framework");
			}

			framework = value;
			index++;
			continue;
		}
		if (argument?.startsWith("--")) {
			throw new Error(`Unknown option: ${argument}`);
		}
		if (!argument || directorySet) {
			throw new Error("Usage: norstar init [directory] [--framework <specifier>]");
		}

		directory = argument;
		directorySet = true;
	}

	return { command: "init", directory, framework };
}
