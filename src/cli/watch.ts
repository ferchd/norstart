import { watch } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ApplicationCliOptions } from "./arguments.ts";
import { buildApplication } from "./build.ts";
import { reportCliError } from "./diagnostics.ts";

export async function developApplication(
	options: ApplicationCliOptions,
	rootDirectory: string,
): Promise<void> {
	let child: ReturnType<typeof Bun.spawn> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	let revision = 0;
	let rebuild = Promise.resolve();
	let finish!: () => void;
	const finished = new Promise<void>((resolveFinished) => {
		finish = resolveFinished;
	});
	const outputDirectory = resolve(rootDirectory, options.outdir);
	const ignored = new Set(["node_modules", ".git", ".norstar"]);
	const restart = async (): Promise<void> => {
		if (stopped) {
			return;
		}

		const currentRevision = revision;
		if (child) {
			child.kill("SIGTERM");
			await child.exited;
			child = undefined;
		}

		try {
			const output = await buildApplication(options, rootDirectory);
			if (!stopped && currentRevision === revision) {
				child = Bun.spawn([process.execPath, output], {
					cwd: rootDirectory,
					stdin: "inherit",
					stdout: "inherit",
					stderr: "inherit",
				});
			}
		} catch (error) {
			reportCliError(error);
		}
	};
	const watcher = watch(rootDirectory, { recursive: true }, (_event, filename) => {
		if (!filename || stopped) {
			return;
		}

		const segments = filename.split(/[\\/]/);
		const changedPath = resolve(rootDirectory, filename);
		const relativeToOutput = relative(outputDirectory, changedPath);
		if (
			segments.some((segment) => ignored.has(segment)) ||
			relativeToOutput === "" ||
			(!relativeToOutput.startsWith(`..${sep}`) &&
				relativeToOutput !== ".." &&
				!isAbsolute(relativeToOutput))
		) {
			return;
		}
		if (!/\.(?:[cm]?[jt]sx?|toml|json)$/.test(filename)) {
			return;
		}

		revision++;
		clearTimeout(timer);
		timer = setTimeout(() => {
			rebuild = rebuild.then(restart);
		}, 100);
	});
	const stop = (): void => {
		stopped = true;
		watcher.close();
		clearTimeout(timer);
		child?.kill("SIGTERM");
		finish();
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);

	try {
		rebuild = restart();
		await finished;
		await rebuild;
		await child?.exited;
	} finally {
		watcher.close();
		clearTimeout(timer);
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
}
