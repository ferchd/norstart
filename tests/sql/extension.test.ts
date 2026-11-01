import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Application } from "../../src/core/application.ts";
import { SqlClient, createSqlExtension } from "../../src/sql/index.ts";
import { column, identifier, selectQuery } from "../../src/query/index.ts";
import { buildApplication } from "../../src/cli/build.ts";
import { withTemporaryDirectory } from "../core/helpers.ts";

const schemaQuery = selectQuery({
	from: { name: identifier("sqlite_master") },
	columns: [{ expression: column("name") }],
});

test("SQL extension creates no connection during create and closes the shared singleton", async () => {
	await withTemporaryDirectory(async (directory) => {
		const file = join(directory, "database.sqlite");
		const path = join(directory, "framework.toml");
		await writeFile(path, '[profiles.job]\ntype = "job"');
		const options = {
			url: `sqlite://${file.replaceAll("\\", "/")}`,
			dialect: "sqlite" as const,
		};
		const extension = createSqlExtension(options);
		options.url = ":memory:";
		let client: SqlClient | undefined;
		const application = Application.configure({
			configPath: path,
			handleProcessSignals: false,
			extensions: [extension],
			drivers: [
				{
					type: "job",
					create({ services }) {
						client = services.get(SqlClient);
						let finish!: () => void;
						const finished = new Promise<void>((resolve) => {
							finish = resolve;
						});

						return {
							mode: "finite",
							finished,
							async start() {
								expect(services.get(SqlClient)).toBe(client!);
								expect(await services.get(SqlClient).execute(schemaQuery)).toEqual(
									[],
								);
								finish();
							},
							stop() {},
						};
					},
				},
			],
		}).create();

		expect(await Bun.file(file).exists()).toBe(false);
		expect(client).toBeUndefined();
		expect((await application.run()).status).toBe("completed");
		expect(await Bun.file(file).exists()).toBe(true);
		expect(client).toBeDefined();
		await expect(client!.execute(schemaQuery)).rejects.toThrow();
		await expect(client!.connect()).rejects.toThrow();
	});
});

test("bundles static SQL providers and TOML while resolving environment configuration at runtime", async () => {
	const directory = await mkdtemp(join(process.cwd(), ".norstar-cli-test-sql-ext-"));
	try {
		const src = join(directory, "src");
		await mkdir(src);
		const example = fileURLToPath(new URL("../../examples/sql-client/", import.meta.url));
		for (const file of ["config.d.ts", "database.extension.ts", "inspector.service.ts"]) {
			await writeFile(join(src, file), await readFile(join(example, "src", file)));
		}
		await writeFile(
			join(directory, "framework.toml"),
			await readFile(join(example, "framework.toml")),
		);
		await writeFile(
			join(src, "main.ts"),
			`import { Application } from "norstar";
import { SqlClient } from "norstar/sql";
import { column, identifier, selectQuery } from "norstar/query";
import { Inspector } from "./inspector.service.ts";
let client: SqlClient;
const app = Application.configure({
	drivers: [{
		type: "job",
		create({ services }) {
			client = services.get(SqlClient);
			let finish!: () => void;
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});
			return {
				mode: "finite",
				finished,
				async start() {
					console.log(JSON.stringify(await services.get(Inspector).tables()));
					finish();
				},
				stop() {},
			};
		},
	}],
}).create();
console.log((await app.run()).status);
try {
	await client!.execute(
		selectQuery({
			from: { name: identifier("sqlite_master") },
			columns: [{ expression: column("name") }],
		}),
	);
	throw new Error("client stayed open");
} catch (error) {
	if (error instanceof Error && error.message === "client stayed open") {
		throw error;
	}
	console.log("closed");
}`,
		);
		const database = join(directory, "from-environment.sqlite");
		const artifact = await buildApplication(
			{
				command: "build",
				configPath: "framework.toml",
				entry: "src/main.ts",
				outdir: "dist",
			},
			directory,
		);
		expect(await Bun.file(database).exists()).toBe(false);
		await rm(src, { recursive: true });
		await rm(join(directory, "framework.toml"));
		await rm(join(directory, ".norstar"), { recursive: true });
		const child = Bun.spawn([process.execPath, artifact], {
			cwd: directory,
			env: {
				...process.env,
				NORSTAR_DATABASE_URL: `sqlite://${database.replaceAll("\\", "/")}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);

		expect(code).toBe(0);
		expect(stderr).toBe("");
		expect(stdout.trim().split(/\r?\n/)).toEqual(["[]", "completed", "closed"]);
		expect(await Bun.file(database).exists()).toBe(true);
	} finally {
		await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}, 30000);
