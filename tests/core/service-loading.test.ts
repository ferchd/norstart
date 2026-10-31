import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Application } from "../../src/core/application.ts";
import { withTemporaryDirectory } from "./helpers.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});

	return { promise, resolve };
}

test.each([false, true])(
	"stops while service import is pending (late rejection: %s)",
	async (reject) => {
		await withTemporaryDirectory(async (directory) => {
			const entered = deferred();
			const gate = deferred();
			const control = { entered: entered.resolve, gate: gate.promise, metadataReads: 0 };
			const key = `norstar-service-test-${directory}`;
			const globals = globalThis as typeof globalThis & Record<string, unknown>;
			globals[key] = control;
			const modulePath = join(directory, "services.ts");
			const moduleUrl = pathToFileURL(modulePath).href;
			await writeFile(
				modulePath,
				`
const control = globalThis[${JSON.stringify(key)}];
control.entered();
await control.gate;
if (${reject}) {
	throw new Error("late import failure");
}
export class Service {
	static get norstarService() {
		control.metadataReads++;
		return { lifetime: "singleton", inject: [] };
	}
}
`,
			);
			const configPath = join(directory, "framework.toml");
			await writeFile(
				configPath,
				`[application]\nserviceModules = [${JSON.stringify(modulePath)}]\n[profiles.main]\ntype = "test"`,
			);
			let createCalls = 0;
			const application = Application.configure({
				configPath,
				drivers: [
					{
						type: "test",
						create: () => {
							createCalls++;
							throw new Error("profile must not be created");
						},
					},
				],
			}).create();
			const initialListeners = process.listenerCount("SIGTERM");
			const originalExitCode = process.exitCode;
			try {
				const running = application.run();
				await entered.promise;
				const result = await application.stop();
				expect(await running).toBe(result);
				expect(result.status).toBe("stopped");
				expect(result.reason).toBe("requested");
				expect(result.exitCode).toBe(0);
				expect(process.listenerCount("SIGTERM")).toBe(initialListeners);
				gate.resolve();
				await import(moduleUrl).catch(() => undefined);
				expect(control.metadataReads).toBe(0);
				expect(createCalls).toBe(0);
				expect(process.exitCode).toBe(originalExitCode);
			} finally {
				gate.resolve();
				await application.stop();
				delete globals[key];
			}
		});
	},
);

test.each([false, true])(
	"skips service loading when stopped immediately (run first: %s)",
	async (runFirst) => {
		await withTemporaryDirectory(async (directory) => {
			const configPath = join(directory, "framework.toml");
			await writeFile(
				configPath,
				'[application]\nserviceModules = ["does-not-exist.ts"]\n[profiles.main]\ntype = "test"',
			);
			const application = Application.configure({ configPath }).create();
			const running = runFirst ? application.run() : undefined;
			const stopped = await application.stop();
			expect(await (running ?? application.run())).toBe(stopped);
			expect(stopped.exitCode).toBe(0);
		});
	},
);
