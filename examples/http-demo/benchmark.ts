import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Application, Container } from "norstar";
import { UserController, UserStore } from "./user-controller.ts";

function reservePort(): number {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	if (server.port === undefined) {
		server.stop(true);
		throw new Error("Bun did not assign an ephemeral port");
	}

	const port = server.port;
	server.stop(true);

	return port;
}

async function waitForServer(url: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const response = await fetch(url);
			await response.arrayBuffer();

			return;
		} catch {
			await Bun.sleep(10);
		}
	}

	throw new Error(`HTTP server did not respond: ${url}`);
}

async function measure(url: string, iterations: number): Promise<number> {
	const startedAt = performance.now();
	for (let index = 0; index < iterations; index++) {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Benchmark request failed with status ${response.status}`);
		}

		await response.arrayBuffer();
	}

	const elapsedSeconds = (performance.now() - startedAt) / 1000;

	return iterations / elapsedSeconds;
}

function median(values: readonly number[]): number {
	const ordered = [...values].sort((first, second) => first - second);
	const middle = Math.floor(ordered.length / 2);
	const lower = ordered[middle - 1] ?? 0;
	const upper = ordered[middle] ?? 0;

	return ordered.length % 2 === 0 ? (lower + upper) / 2 : upper;
}

const iterations = Number(process.env.BENCHMARK_ITERATIONS ?? 1000);
if (!Number.isInteger(iterations) || iterations < 1) {
	throw new Error("BENCHMARK_ITERATIONS must be a positive integer");
}

const directory = await mkdtemp(join(tmpdir(), "norstar-http-benchmark-"));
const configPath = join(directory, "framework.toml");
const routePath = fileURLToPath(new URL("./routes/api.ts", import.meta.url))
	.replaceAll("\\", "/")
	.replaceAll('"', '\\"');
let nativeServer: ReturnType<typeof Bun.serve> | undefined;
let application: ReturnType<ReturnType<typeof Application.configure>["create"]> | undefined;
let applicationRun: ReturnType<NonNullable<typeof application>["run"]> | undefined;

try {
	const port = reservePort();
	await writeFile(
		configPath,
		`[profiles.http]\ntype = "http-server"\nport = ${port}\nhostname = "127.0.0.1"\n\n[profiles.http.routes]\napi = "${routePath}"\n`,
	);
	application = Application.configure({
		configPath,
		configureServices: (services: Container) => {
			services.register(UserStore, () => new UserStore(), "scoped");
			services.register(
				UserController,
				(resolver) => new UserController(resolver.get(UserStore)),
				"scoped",
			);
		},
	}).create();
	nativeServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json({ status: "ok" }),
	});
	if (nativeServer.port === undefined) {
		throw new Error("Bun did not assign an ephemeral port");
	}

	const nativeUrl = `http://127.0.0.1:${nativeServer.port}/health`;
	const norstarUrl = `http://127.0.0.1:${port}/health`;
	applicationRun = application.run();
	await waitForServer(norstarUrl);
	await measure(nativeUrl, 100);
	await measure(norstarUrl, 100);

	const nativeRates: number[] = [];
	const norstarRates: number[] = [];
	for (let round = 0; round < 3; round++) {
		if (round % 2 === 0) {
			nativeRates.push(await measure(nativeUrl, iterations));
			norstarRates.push(await measure(norstarUrl, iterations));
		} else {
			norstarRates.push(await measure(norstarUrl, iterations));
			nativeRates.push(await measure(nativeUrl, iterations));
		}
	}
	const nativeRate = median(nativeRates);
	const norstarRate = median(norstarRates);
	console.log(`Native Bun.serve: ${nativeRate.toFixed(0)} requests/second`);
	console.log(`Norstar HTTP profile: ${norstarRate.toFixed(0)} requests/second`);
	console.log(`Norstar / native: ${(norstarRate / nativeRate).toFixed(2)}x`);
} finally {
	try {
		nativeServer?.stop(true);
	} finally {
		try {
			if (application) {
				await application.stop("requested");
			}
			if (applicationRun) {
				await applicationRun;
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
}
