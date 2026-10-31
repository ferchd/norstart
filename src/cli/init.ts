import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InitCliOptions } from "./arguments.ts";

const files = {
	".gitignore": "node_modules/\ndist/\n.norstar/\n",
	"framework.toml": `[profiles.http]
type = "http-server"
hostname = "127.0.0.1"
port = 3000

[profiles.http.routes]
api = "src/routes.ts"
`,
	"src/main.ts": `import { Application } from "norstar";

await Application.configure().create().run();
`,
	"README.md": `# Norstar application

Run \`bun install\`, then use \`bun run dev\` for development or \`bun run build\` for production.
`,
	"src/health.ts": `export function health() {
	return { status: "ok" };
}
`,
	"src/routes.ts": `import { Route } from "norstar/http";
import { health } from "./health.ts";

Route.get("/health", health);
`,
	"tests/health.test.ts": `import { expect, test } from "bun:test";
import { health } from "../src/health.ts";

test("health route reports readiness", () => {
	expect(health()).toEqual({ status: "ok" });
});
`,
	"tsconfig.json": `${JSON.stringify(
		{
			compilerOptions: {
				allowImportingTsExtensions: true,
				module: "Preserve",
				moduleDetection: "force",
				moduleResolution: "bundler",
				noEmit: true,
				strict: true,
				target: "ESNext",
				types: ["bun"],
			},
			include: ["src/**/*.ts", "tests/**/*.ts"],
		},
		null,
		2,
	)}\n`,
} as const;

export async function initializeApplication(
	options: InitCliOptions,
	rootDirectory: string,
): Promise<string> {
	const directory = resolve(rootDirectory, options.directory);
	const target = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			return undefined;
		}

		throw error;
	});
	if (target && (!target.isDirectory() || target.isSymbolicLink())) {
		throw new Error(`Initialization target must be a regular directory: ${directory}`);
	}

	const existing = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			return undefined;
		}

		throw error;
	});
	if (existing && existing.length > 0) {
		throw new Error(`Initialization target must be empty: ${directory}`);
	}

	const framework = options.framework ?? (await defaultFrameworkSpecifier());
	if (!framework.trim() || /[\r\n]/.test(framework)) {
		throw new Error("Framework specifier must be a non-empty single line");
	}

	await Promise.all([
		mkdir(resolve(directory, "src"), { recursive: true }),
		mkdir(resolve(directory, "tests"), { recursive: true }),
	]);
	const packageSource = `${JSON.stringify(
		{
			name: packageName(basename(directory)),
			private: true,
			type: "module",
			scripts: {
				build: "norstar build",
				check: "norstar check",
				dev: "norstar dev",
				start: "bun dist/main.js",
				test: "bun test",
				typecheck: "tsc --noEmit",
			},
			dependencies: { norstar: framework },
			devDependencies: { "@types/bun": "latest", typescript: "^6.0.2" },
		},
		null,
		2,
	)}\n`;
	await Promise.all([
		...Object.entries(files).map(([path, source]) =>
			writeFile(resolve(directory, path), source, { flag: "wx" }),
		),
		writeFile(resolve(directory, "package.json"), packageSource, { flag: "wx" }),
	]);

	return directory;
}

async function defaultFrameworkSpecifier(): Promise<string> {
	const metadata = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
		private?: unknown;
		version?: unknown;
	};
	if (typeof metadata.version !== "string" || !metadata.version.trim()) {
		throw new Error("Norstar package version is unavailable");
	}
	if (metadata.private === true) {
		return `file:${fileURLToPath(new URL("../../", import.meta.url))}`;
	}

	return `^${metadata.version}`;
}

function packageName(directory: string): string {
	const name = directory
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[._-]+|[._-]+$/g, "");

	return name || "norstar-app";
}
