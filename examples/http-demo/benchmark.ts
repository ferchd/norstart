import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "norstar";

interface BenchmarkSample {
	readonly requestsPerSecond: number;
	readonly p50Ms: number;
	readonly p95Ms: number;
	readonly p99Ms: number;
}

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

function positiveInteger(name: string, fallback: number): number {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer`);
	}

	return value;
}

function positiveIntegerList(name: string, fallback: string): number[] {
	const values = (process.env[name] ?? fallback).split(",").map((value) => Number(value.trim()));
	if (values.some((value) => !Number.isInteger(value) || value < 1)) {
		throw new Error(`${name} must contain comma-separated positive integers`);
	}

	return [...new Set(values)];
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

async function measure(
	url: string,
	iterations: number,
	concurrency: number,
): Promise<BenchmarkSample> {
	const latencies = new Array<number>(iterations);
	const workers = Math.min(iterations, concurrency);
	let nextIteration = 0;
	const startedAt = performance.now();

	await Promise.all(
		Array.from({ length: workers }, async () => {
			while (true) {
				const index = nextIteration++;
				if (index >= iterations) {
					return;
				}

				const requestStartedAt = performance.now();
				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(`Benchmark request failed with status ${response.status}`);
				}

				await response.arrayBuffer();
				latencies[index] = performance.now() - requestStartedAt;
			}
		}),
	);

	const elapsedSeconds = (performance.now() - startedAt) / 1000;

	return {
		requestsPerSecond: iterations / elapsedSeconds,
		p50Ms: percentile(latencies, 0.5),
		p95Ms: percentile(latencies, 0.95),
		p99Ms: percentile(latencies, 0.99),
	};
}

function percentile(values: readonly number[], fraction: number): number {
	const ordered = [...values].sort((first, second) => first - second);
	const index = Math.max(0, Math.ceil(ordered.length * fraction) - 1);

	return ordered[index] ?? 0;
}

function median(values: readonly number[]): number {
	const ordered = [...values].sort((first, second) => first - second);
	const middle = Math.floor(ordered.length / 2);
	const lower = ordered[middle - 1] ?? 0;
	const upper = ordered[middle] ?? 0;

	return ordered.length % 2 === 0 ? (lower + upper) / 2 : upper;
}

function summarize(samples: readonly BenchmarkSample[]): BenchmarkSample {
	return {
		requestsPerSecond: median(samples.map((sample) => sample.requestsPerSecond)),
		p50Ms: median(samples.map((sample) => sample.p50Ms)),
		p95Ms: median(samples.map((sample) => sample.p95Ms)),
		p99Ms: median(samples.map((sample) => sample.p99Ms)),
	};
}

function createNativeRoutes(routeCount: number) {
	const routes: Record<string, { GET: () => Response }> = {};
	for (let index = 0; index < routeCount; index++) {
		routes[`/route-${index}/:id`] = {
			GET: () => Response.json({ status: "ok" }),
		};
	}

	return routes;
}

function formatSample(name: string, sample: BenchmarkSample): string {
	return `${name}: ${sample.requestsPerSecond.toFixed(0)} req/s, p50 ${sample.p50Ms.toFixed(2)} ms, p95 ${sample.p95Ms.toFixed(2)} ms, p99 ${sample.p99Ms.toFixed(2)} ms`;
}

const iterations = positiveInteger("BENCHMARK_ITERATIONS", 500);
const routeCounts = positiveIntegerList("BENCHMARK_ROUTE_COUNTS", "1,100,1000");
const concurrencyLevels = positiveIntegerList("BENCHMARK_CONCURRENCY", "1,8,32");
const directory = await mkdtemp(join(tmpdir(), "norstar-http-benchmark-"));
const workingDirectory = await mkdtemp(join(process.cwd(), ".norstar-http-benchmark-"));

try {
	console.log(`Bun ${process.versions.bun}; ${process.platform}/${process.arch}`);
	console.log(
		`Iterations: ${iterations}; route counts: ${routeCounts.join(", ")}; concurrency: ${concurrencyLevels.join(", ")}`,
	);

	for (const [scenarioIndex, routeCount] of routeCounts.entries()) {
		const routeLines = [
			'import { Route } from "norstar/http";',
			...Array.from(
				{ length: routeCount },
				(_, index) => `Route.get("/route-${index}/:id", () => ({ status: "ok" }));`,
			),
		].join("\n\n");
		const routeModulePath = join(workingDirectory, `routes-${routeCount}.ts`);
		const port = reservePort();
		await writeFile(routeModulePath, `${routeLines}\n`);

		const nativeServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			routes: createNativeRoutes(routeCount),
			fetch: () => Response.json({ error: "Not Found" }, { status: 404 }),
		});
		if (nativeServer.port === undefined) {
			nativeServer.stop(true);
			throw new Error("Bun did not assign an ephemeral port");
		}

		const nativeUrl = `http://127.0.0.1:${nativeServer.port}/route-${routeCount - 1}/benchmark`;
		const routeIndex = routeCount - 1;
		const routeConfigPath = join(directory, `framework-route-${routeCount}.toml`);
		await writeFile(
			routeConfigPath,
			`[profiles.http]\ntype = "http-server"\nport = ${port}\nhostname = "127.0.0.1"\n\n[profiles.http.routes]\napi = ${JSON.stringify(routeModulePath)}\n`,
		);
		const application = Application.configure({ configPath: routeConfigPath }).create();
		const applicationRun = application.run();
		const norstarUrl = `http://127.0.0.1:${port}/route-${routeIndex}/benchmark`;
		const memoryBefore = process.memoryUsage();

		try {
			await waitForServer(nativeUrl);
			await waitForServer(norstarUrl);
			await measure(nativeUrl, 100, Math.min(8, iterations));
			await measure(norstarUrl, 100, Math.min(8, iterations));

			const memoryAfterWarmup = process.memoryUsage();
			console.log(
				`\nRoutes: ${routeCount}; memory snapshot (heap/RSS): ${(memoryBefore.heapUsed / 1_048_576).toFixed(1)}/${(memoryBefore.rss / 1_048_576).toFixed(1)} MiB before, ${(memoryAfterWarmup.heapUsed / 1_048_576).toFixed(1)}/${(memoryAfterWarmup.rss / 1_048_576).toFixed(1)} MiB after warmup`,
			);

			for (const [concurrencyIndex, concurrency] of concurrencyLevels.entries()) {
				const nativeSamples: BenchmarkSample[] = [];
				const norstarSamples: BenchmarkSample[] = [];
				for (let round = 0; round < 3; round++) {
					const nativeFirst = (scenarioIndex + concurrencyIndex + round) % 2 === 0;
					if (nativeFirst) {
						nativeSamples.push(await measure(nativeUrl, iterations, concurrency));
						norstarSamples.push(await measure(norstarUrl, iterations, concurrency));
					} else {
						norstarSamples.push(await measure(norstarUrl, iterations, concurrency));
						nativeSamples.push(await measure(nativeUrl, iterations, concurrency));
					}
				}

				console.log(`Concurrency ${concurrency}`);
				console.log(formatSample("  Bun native", summarize(nativeSamples)));
				console.log(formatSample("  Norstar", summarize(norstarSamples)));
			}
		} finally {
			nativeServer.stop(true);
			await application.stop("requested");
			await applicationRun;
		}
	}
} finally {
	await rm(directory, { recursive: true, force: true });
	await rm(workingDirectory, { recursive: true, force: true });
}
