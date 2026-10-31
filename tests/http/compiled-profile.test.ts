import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildApplication } from "../../src/cli/build.ts";

test("serves compiled HTTP routes and inferred controllers after removing source files", async () => {
	const directory = await mkdtemp(join(process.cwd(), ".norstar-compiled-http-"));
	let child: ReturnType<typeof Bun.spawn> | undefined;
	const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
	const port = reservation.port;
	await reservation.stop(true);
	try {
		await mkdir(join(directory, "src"));
		const files: Record<string, string> = {
			"framework.toml": `[profiles.web]\ntype = "http-server"\nport = ${port}\nhostname = "127.0.0.1"\n[profiles.web.routes]\napi = "src/api.ts"\nother = "src/other.ts"`,
			"src/main.ts":
				'import { Application } from "norstar";\nApplication.configure().create().run();',
			"src/message.service.ts":
				'export class MessageService {\ntext() {\nreturn "compiled hello";\n}\n}',
			"src/message.controller.ts":
				'import { MessageService } from "./message.service.ts";\nexport class MessageController {\nconstructor(private readonly message: MessageService) {}\nindex() {\nreturn { message: this.message.text() };\n}\n}',
			"src/api.ts":
				'import { Route } from "norstar/http";\nimport { MessageController } from "./message.controller.ts";\nRoute.get("/hello", [MessageController, "index"]);',
			"src/other.ts":
				'import { Route } from "norstar/http";\nRoute.get("/other/:id", ({ params }) => ({ id: params.id }));',
		};
		for (const [path, source] of Object.entries(files)) {
			await writeFile(join(directory, path), source);
		}
		const output = await buildApplication(
			{
				command: "build",
				configPath: "framework.toml",
				entry: "src/main.ts",
				outdir: "dist",
			},
			directory,
		);
		await rm(join(directory, "src"), { recursive: true });
		await rm(join(directory, "framework.toml"));
		await rm(join(directory, ".norstar"), { recursive: true });
		child = Bun.spawn([process.execPath, output], {
			cwd: directory,
			stdout: "ignore",
			stderr: "pipe",
		});
		let response: Response | undefined;
		for (let attempt = 0; attempt < 100; attempt++) {
			response = await fetch(`http://127.0.0.1:${port}/hello`).catch(() => undefined);
			if (response) {
				break;
			}

			await Bun.sleep(20);
		}
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({ message: "compiled hello" });
		const other = await fetch(`http://127.0.0.1:${port}/other/42`);
		expect(await other.json()).toEqual({ id: "42" });
	} finally {
		if (child) {
			child.kill("SIGTERM");
			await child.exited;
		}

		await rm(directory, { recursive: true, force: true });
	}
}, 30000);
