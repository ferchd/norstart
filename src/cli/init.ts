import { constants } from "node:fs";
import {
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	rename,
	rm,
	rmdir,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
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
				types: ["bun", "node"],
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
			devDependencies: {
				"@types/bun": "^1.4.4",
				"@types/node": "^26.6.6",
				typescript: "^6.0.2",
			},
		},
		null,
		2,
	)}\n`;
	const parent = dirname(directory);
	await mkdir(parent, { recursive: true });
	const staging = await mkdtemp(resolve(parent, `.${basename(directory)}.norstar-`));
	try {
		await writeProject(staging, packageSource);
		if (target) {
			await publishToExistingDirectory(staging, directory);
		} else {
			await rename(staging, directory);
		}
	} finally {
		await rm(staging, { recursive: true, force: true });
	}

	return directory;
}

interface CreatedEntry {
	readonly path: string;
	readonly directory: boolean;
	readonly device: number;
	readonly inode: number;
}

export async function publishToExistingDirectory(
	staging: string,
	directory: string,
): Promise<void> {
	const entries = (await readdir(staging)).sort();
	const created: CreatedEntry[] = [];
	try {
		for (const entry of entries) {
			await copyEntry(resolve(staging, entry), resolve(directory, entry), created);
		}
	} catch (cause) {
		const rollbackErrors: unknown[] = [];
		for (const entry of created.reverse()) {
			try {
				const current = await lstat(entry.path);
				if (current.dev !== entry.device || current.ino !== entry.inode) {
					continue;
				}
				if (entry.directory) {
					await rmdir(entry.path);
				} else {
					await rm(entry.path);
				}
			} catch (error) {
				rollbackErrors.push(error);
			}
		}
		if (rollbackErrors.length > 0) {
			throw new AggregateError(
				rollbackErrors,
				"Application initialization and rollback failed",
				{ cause },
			);
		}

		throw cause;
	}
}

async function copyEntry(
	source: string,
	destination: string,
	created: CreatedEntry[],
): Promise<void> {
	const sourceStats = await lstat(source);
	if (sourceStats.isDirectory()) {
		await mkdir(destination);
		const destinationStats = await lstat(destination);
		created.push({
			path: destination,
			directory: true,
			device: destinationStats.dev,
			inode: destinationStats.ino,
		});
		for (const entry of (await readdir(source)).sort()) {
			await copyEntry(resolve(source, entry), resolve(destination, entry), created);
		}

		return;
	}

	await copyFile(source, destination, constants.COPYFILE_EXCL);
	const destinationStats = await lstat(destination);
	created.push({
		path: destination,
		directory: false,
		device: destinationStats.dev,
		inode: destinationStats.ino,
	});
}

async function writeProject(directory: string, packageSource: string): Promise<void> {
	await Promise.all([mkdir(resolve(directory, "src")), mkdir(resolve(directory, "tests"))]);
	await Promise.all([
		...Object.entries(files).map(([path, source]) =>
			writeFile(resolve(directory, path), source, { flag: "wx" }),
		),
		writeFile(resolve(directory, "package.json"), packageSource, { flag: "wx" }),
	]);
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
		throw new Error("Private Norstar installations require --framework <specifier>");
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
