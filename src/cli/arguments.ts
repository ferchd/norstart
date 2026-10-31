export interface CliOptions {
	readonly command: "check" | "build" | "dev";
	readonly configPath: string;
	readonly entry: string;
	readonly outdir: string;
}

export function parseArguments(arguments_: readonly string[]): CliOptions {
	const [command, ...rest] = arguments_;
	if (command !== "check" && command !== "build" && command !== "dev") {
		throw new Error(
			"Usage: norstar <check|build|dev> [--config framework.toml] [--entry src/main.ts] [--outdir dist]",
		);
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
