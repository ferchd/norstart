import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Container } from "../../src/core/container.ts";
import { Application } from "norstar";
import { FixtureController, RequestState } from "./fixtures/controllers.ts";

async function withTemporaryDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "norstar-http-test-"));

	try {
		return await operation(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function reservePort(): number {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	if (server.port === undefined) {
		server.stop(true);
		throw new Error("Bun did not assign an ephemeral test port");
	}

	const port = server.port;
	server.stop(true);

	return port;
}

async function waitForResponse(url: string): Promise<Response> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			return await fetch(url);
		} catch {
			await Bun.sleep(10);
		}
	}

	throw new Error(`HTTP server did not respond: ${url}`);
}

describe("HTTP profile contract", () => {
	test("auto-registers the driver and owns request scopes through shutdown", async () => {
		await withTemporaryDirectory(async (directory) => {
			const port = reservePort();
			const configPath = join(directory, "framework.toml");
			const routeModulePath = fileURLToPath(
				new URL("./fixtures/routes.ts", import.meta.url),
			).replaceAll("\\", "/");
			await writeFile(
				configPath,
				`[profiles.web]\ntype = "http-server"\nport = ${port}\nhostname = "127.0.0.1"\n\n[profiles.web.routes]\napi = "${routeModulePath}"\n`,
			);

			const createdStateIds: number[] = [];
			const disposedStateIds: number[] = [];
			const application = Application.configure({
				configPath,
				configureServices: (container: Container) => {
					container.register(
						RequestState,
						() => {
							const id = createdStateIds.length + 1;
							createdStateIds.push(id);

							return new RequestState(id, () => {
								disposedStateIds.push(id);
							});
						},
						"scoped",
					);
					container.register(
						FixtureController,
						(resolver) => new FixtureController(resolver.get(RequestState)),
						"scoped",
					);
				},
			}).create();
			const serverUrl = `http://127.0.0.1:${port}`;

			await expect(fetch(`${serverUrl}/json/not-started`)).rejects.toThrow();

			const running = application.run();
			try {
				const json = await waitForResponse(`${serverUrl}/json/ready`);
				const firstControllerResponse = await fetch(`${serverUrl}/controller/first`);
				const secondControllerResponse = await fetch(`${serverUrl}/controller/second`);
				const knownError = await fetch(`${serverUrl}/http-error`);
				const unknownError = await fetch(`${serverUrl}/unexpected-error`);
				const notFound = await fetch(`${serverUrl}/missing`);

				expect(json.status).toBe(200);
				expect(await json.json()).toEqual({ id: "ready" });
				expect(await firstControllerResponse.json()).toEqual({ id: "first", stateId: 1 });
				expect(await secondControllerResponse.json()).toEqual({ id: "second", stateId: 2 });
				expect(knownError.status).toBe(418);
				expect(await knownError.text()).toContain("short and stout");
				expect(unknownError.status).toBe(500);
				expect(await unknownError.text()).not.toContain("secret implementation detail");
				expect(notFound.status).toBe(404);
				expect(createdStateIds).toEqual([1, 2, 3, 4]);
				expect(disposedStateIds).toEqual([1, 2, 3, 4]);

				const result = await application.stop("requested");
				expect(result.status).toBe("stopped");
				expect(await running).toBe(result);
				await expect(fetch(`${serverUrl}/json/stopped`)).rejects.toThrow();
			} finally {
				await application.stop("requested");
			}
		});
	});
});
