import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Container } from "../../src/core/container.ts";
import { HttpRouter } from "../../src/http/router.ts";
import { FixtureController, RequestState } from "./fixtures/controllers.ts";

const routeModulePath = fileURLToPath(new URL("./fixtures/routes.ts", import.meta.url));
const duplicateRouteModulePath = fileURLToPath(
	new URL("./fixtures/duplicate-routes.ts", import.meta.url),
);

interface ScopeMetrics {
	created: number;
	disposed: number;
}

function services(onRequestStateDispose: () => void): Container {
	let nextRequestStateId = 0;
	const container = new Container();

	container.register(
		RequestState,
		() => new RequestState(++nextRequestStateId, onRequestStateDispose),
		"scoped",
	);
	container.register(
		FixtureController,
		(resolver) => new FixtureController(resolver.get(RequestState)),
		"scoped",
	);

	return container;
}

function createScopeFactory(container: Container, metrics: ScopeMetrics) {
	return () => {
		metrics.created++;
		const scope = container.createScope();

		return {
			get: scope.get,
			dispose: async () => {
				metrics.disposed++;
				await scope.dispose();
			},
		};
	};
}

async function createRouter(): Promise<HttpRouter> {
	return HttpRouter.load({ api: routeModulePath });
}

describe("HTTP router contract", () => {
	test("maps route parameters and normalizes handler results", async () => {
		const router = await createRouter();
		const metrics = { created: 0, disposed: 0 };
		const container = services(() => undefined);
		const createScope = createScopeFactory(container, metrics);

		const json = await router.handle(new Request("http://localhost/json/42"), createScope);
		const staticRoute = await router.handle(
			new Request("http://localhost/priority/new"),
			createScope,
		);
		const text = await router.handle(new Request("http://localhost/text"), createScope);
		const empty = await router.handle(new Request("http://localhost/empty"), createScope);
		const scopeOwnership = await router.handle(
			new Request("http://localhost/scope-ownership"),
			createScope,
		);
		const explicit = await router.handle(new Request("http://localhost/explicit"), createScope);
		const echoed = await router.handle(
			new Request("http://localhost/echo", {
				method: "POST",
				body: JSON.stringify({ message: "received" }),
				headers: { "content-type": "application/json" },
			}),
			createScope,
		);

		expect(json.status).toBe(200);
		expect(await json.json()).toEqual({ id: "42" });
		expect(await staticRoute.json()).toEqual({ route: "static" });
		expect(text.headers.get("content-type")).toContain("text/plain");
		expect(await text.text()).toBe("plain response");
		expect(empty.status).toBe(204);
		expect(await scopeOwnership.json()).toEqual({ canDispose: false });
		expect(explicit.status).toBe(202);
		expect(await explicit.text()).toBe("accepted");
		expect(await echoed.json()).toEqual({ message: "received" });
		expect(metrics).toEqual({ created: 7, disposed: 7 });
		await container.dispose();
	});

	test("resolves a controller and its scoped dependency separately per request", async () => {
		const router = await createRouter();
		const metrics = { created: 0, disposed: 0 };
		const disposedStateIds: number[] = [];
		const container = services(() => {
			disposedStateIds.push(disposedStateIds.length + 1);
		});
		const createScope = createScopeFactory(container, metrics);

		const first = await router.handle(
			new Request("http://localhost/controller/first"),
			createScope,
		);
		const second = await router.handle(
			new Request("http://localhost/controller/second"),
			createScope,
		);

		expect(await first.json()).toEqual({ id: "first", stateId: 1 });
		expect(await second.json()).toEqual({ id: "second", stateId: 2 });
		expect(metrics).toEqual({ created: 2, disposed: 2 });
		expect(disposedStateIds).toEqual([1, 2]);
		await container.dispose();
	});

	test("disposes request services after HttpError and hides unexpected failures", async () => {
		const router = await createRouter();
		const metrics = { created: 0, disposed: 0 };
		let requestStateDisposals = 0;
		const container = services(() => {
			requestStateDisposals++;
		});
		const createScope = createScopeFactory(container, metrics);

		const knownError = await router.handle(
			new Request("http://localhost/http-error"),
			createScope,
		);
		const unknownError = await router.handle(
			new Request("http://localhost/unexpected-error"),
			createScope,
		);
		const internalHttpError = await router.handle(
			new Request("http://localhost/server-error"),
			createScope,
		);
		const exposedHttpError = await router.handle(
			new Request("http://localhost/public-server-error"),
			createScope,
		);
		const knownBody = await knownError.text();
		const unknownBody = await unknownError.text();
		const internalHttpErrorBody = await internalHttpError.text();
		const exposedHttpErrorBody = await exposedHttpError.text();

		expect(knownError.status).toBe(418);
		expect(knownBody).toContain("short and stout");
		expect(unknownError.status).toBe(500);
		expect(unknownBody).toContain("Internal Server Error");
		expect(unknownBody).not.toContain("secret implementation detail");
		expect(internalHttpError.status).toBe(500);
		expect(internalHttpErrorBody).toContain("Internal Server Error");
		expect(internalHttpErrorBody).not.toContain("secret server detail");
		expect(exposedHttpError.status).toBe(503);
		expect(exposedHttpErrorBody).toContain("Temporarily unavailable");
		expect(metrics).toEqual({ created: 4, disposed: 4 });
		expect(requestStateDisposals).toBe(2);
		await container.dispose();
	});

	test("creates and disposes a scope for a not-found request", async () => {
		const router = await createRouter();
		const metrics = { created: 0, disposed: 0 };
		const container = services(() => undefined);
		const createScope = createScopeFactory(container, metrics);

		const response = await router.handle(new Request("http://localhost/missing"), createScope);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not Found" });
		expect(metrics).toEqual({ created: 1, disposed: 1 });
		await container.dispose();
	});

	test("disposes the scope when a handler returns a locked response body", async () => {
		const router = await createRouter();
		const metrics = { created: 0, disposed: 0 };
		const container = services(() => undefined);
		const response = await router.handle(
			new Request("http://localhost/locked"),
			createScopeFactory(container, metrics),
		);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal Server Error" });
		expect(metrics).toEqual({ created: 1, disposed: 1 });
		await container.dispose();
	});

	test("keeps the request scope alive until a response stream completes or is cancelled", async () => {
		const router = await createRouter();
		const container = services(() => undefined);
		const completedMetrics = { created: 0, disposed: 0 };
		const completedResponse = await router.handle(
			new Request("http://localhost/stream"),
			createScopeFactory(container, completedMetrics),
		);

		expect(completedMetrics).toEqual({ created: 1, disposed: 0 });
		expect(await completedResponse.text()).toBe("streamed response");
		expect(completedMetrics).toEqual({ created: 1, disposed: 1 });

		const cancelledMetrics = { created: 0, disposed: 0 };
		const cancelledResponse = await router.handle(
			new Request("http://localhost/cancel-stream"),
			createScopeFactory(container, cancelledMetrics),
		);

		expect(cancelledMetrics).toEqual({ created: 1, disposed: 0 });
		await cancelledResponse.body?.cancel();
		expect(cancelledMetrics).toEqual({ created: 1, disposed: 1 });

		await container.dispose();
	});

	test("rejects invalid route tables and reports configured module failures", async () => {
		await expect(HttpRouter.load("invalid")).rejects.toThrow(
			"HTTP profile routes must be a table",
		);
		await expect(HttpRouter.load({ api: "" })).rejects.toThrow("must be a non-empty path");
		await expect(
			HttpRouter.load({ api: "tests/http/fixtures/missing-routes.ts" }),
		).rejects.toThrow("Unable to load HTTP routes module");
		await expect(HttpRouter.load({ duplicate: duplicateRouteModulePath })).rejects.toThrow(
			"Duplicate HTTP route matcher: GET /duplicate/:",
		);
	});
});
