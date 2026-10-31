import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ServiceResolver, ServiceScope, ServiceToken } from "../core/contracts.ts";
import { HttpError } from "./errors.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpRequestContext {
	readonly request: Request;
	readonly params: Readonly<Record<string, string>>;
	readonly services: ServiceResolver;
}

export type HttpRouteHandler = (context: HttpRequestContext) => unknown | Promise<unknown>;
export type HttpControllerTarget = readonly [ServiceToken<object>, string];
export type HttpRouteTarget = HttpRouteHandler | HttpControllerTarget;

interface RouteDefinition {
	readonly method: HttpMethod;
	readonly path: string;
	readonly target: HttpRouteTarget;
	readonly matcher: RegExp;
	readonly parameterNames: readonly string[];
}

interface RouteRegistryState {
	activeDefinitions?: RouteDefinition[];
	moduleDefinitions: Map<string, readonly RouteDefinition[]>;
	importQueue: Promise<void>;
}

type BunRouteRequest = Request & { readonly params: Readonly<Record<string, string>> };
type BunRouteHandler = (request: BunRouteRequest) => Promise<Response>;
type BunRouteHandlers = Partial<Record<HttpMethod, BunRouteHandler>>;
type BunRouteTable = Record<string, BunRouteHandlers>;

const routeRegistryKey = "__norstar_http_route_registry__";
const routeRegistryHost = globalThis as typeof globalThis & {
	__norstar_http_route_registry__?: RouteRegistryState;
};
const routeRegistry: RouteRegistryState =
	routeRegistryHost[routeRegistryKey] ??
	({
		moduleDefinitions: new Map<string, readonly RouteDefinition[]>(),
		importQueue: Promise.resolve(),
	} satisfies RouteRegistryState);

routeRegistryHost[routeRegistryKey] = routeRegistry;

export function beginCompiledRoutes(): void {
	if (routeRegistry.activeDefinitions) {
		throw new Error("HTTP route collection is already active");
	}

	routeRegistry.activeDefinitions = [];
}

export function finishCompiledRoutes(modulePath: string): void {
	const definitions = routeRegistry.activeDefinitions;
	if (!definitions) {
		throw new Error("HTTP route collection is not active");
	}

	validateUniqueRoutes(definitions);
	routeRegistry.moduleDefinitions.set(resolve(modulePath), definitions);
	routeRegistry.activeDefinitions = undefined;
}

export class Route {
	static get(path: string, target: HttpRouteTarget): void {
		this.register("GET", path, target);
	}

	static post(path: string, target: HttpRouteTarget): void {
		this.register("POST", path, target);
	}

	static put(path: string, target: HttpRouteTarget): void {
		this.register("PUT", path, target);
	}

	static patch(path: string, target: HttpRouteTarget): void {
		this.register("PATCH", path, target);
	}

	static delete(path: string, target: HttpRouteTarget): void {
		this.register("DELETE", path, target);
	}

	private static register(method: HttpMethod, path: string, target: HttpRouteTarget): void {
		const definitions = routeRegistry.activeDefinitions;
		if (!definitions) {
			throw new Error("Routes may only be declared while loading a configured route module");
		}

		const { matcher, parameterNames } = compilePath(path);
		if (definitions.some((route) => route.method === method && route.path === path)) {
			throw new Error(`Duplicate HTTP route: ${method} ${path}`);
		}

		definitions.push({ method, path, target, matcher, parameterNames });
	}
}

export class HttpRouter {
	private constructor(private readonly routes: readonly RouteDefinition[]) {}

	createBunRoutes(createScope: () => ServiceScope): BunRouteTable {
		const routes: BunRouteTable = Object.create(null) as BunRouteTable;

		for (const route of this.routes) {
			const handlers = routes[route.path] ?? {};
			handlers[route.method] = (request) =>
				this.handleDefinition(request, route, createScope, request.params);
			routes[route.path] = handlers;
		}

		return routes;
	}

	static async load(modules: unknown): Promise<HttpRouter> {
		const paths = readRouteModules(modules);
		const routes: RouteDefinition[] = [];

		await withRouteRegistration(async () => {
			for (const [name, configuredPath] of Object.entries(paths)) {
				const absolutePath = resolve(configuredPath);
				const moduleDefinitions = routeRegistry.moduleDefinitions.get(absolutePath);
				if (moduleDefinitions) {
					routes.push(...moduleDefinitions);

					continue;
				}

				const definitions: RouteDefinition[] = [];
				routeRegistry.activeDefinitions = definitions;

				try {
					await import(pathToFileURL(absolutePath).href);
				} catch (cause) {
					throw new Error(
						`Unable to load HTTP routes module "${name}" from "${absolutePath}"`,
						{ cause },
					);
				} finally {
					routeRegistry.activeDefinitions = undefined;
				}

				routeRegistry.moduleDefinitions.set(absolutePath, definitions);
				routes.push(...definitions);
			}
		});
		validateUniqueRoutes(routes);
		routes.sort(compareRouteSpecificity);

		return new HttpRouter(routes);
	}

	async handle(request: Request, createScope: () => ServiceScope): Promise<Response> {
		return this.handleWithScope(createScope, async (scope) => this.dispatch(request, scope));
	}

	async handleNotFound(createScope: () => ServiceScope): Promise<Response> {
		return this.handleWithScope(createScope, async () =>
			Response.json({ error: "Not Found" }, { status: 404 }),
		);
	}

	private async disposeScopeAfterResponse(
		response: Response,
		scope: ServiceScope,
	): Promise<Response> {
		if (!response.body) {
			try {
				await scope.dispose();
			} catch {
				return errorResponse(new Error("Internal Server Error"));
			}

			return response;
		}

		try {
			const reader = response.body.getReader();
			let disposal: Promise<void> | undefined;
			const dispose = (): Promise<void> => {
				if (!disposal) {
					disposal = scope.dispose();
				}

				return disposal;
			};
			const body = new ReadableStream<Uint8Array>({
				pull: async (controller) => {
					try {
						const chunk = await reader.read();
						if (chunk.done) {
							await dispose();
							controller.close();

							return;
						}

						controller.enqueue(chunk.value);
					} catch {
						try {
							await dispose();
						} catch {
							// Preserve the response boundary when service cleanup also fails.
						}

						controller.error(new Error("Internal Server Error"));
					}
				},
				cancel: async (reason) => {
					try {
						await reader.cancel(reason);
					} finally {
						await dispose();
					}
				},
			});

			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		} catch {
			try {
				await scope.dispose();
			} catch {
				// Preserve a safe response if both body wrapping and disposal fail.
			}

			return errorResponse(new Error("Internal Server Error"));
		}
	}

	private async handleDefinition(
		request: Request,
		route: RouteDefinition,
		createScope: () => ServiceScope,
		params: Readonly<Record<string, string>>,
	): Promise<Response> {
		return this.handleWithScope(createScope, async (scope) => {
			const context = this.createContext(request, params, scope);
			const result = await invokeTarget(route.target, context);

			return toResponse(result);
		});
	}

	private async handleWithScope(
		createScope: () => ServiceScope,
		handle: (scope: ServiceScope) => Promise<Response>,
	): Promise<Response> {
		let scope: ServiceScope;
		try {
			scope = createScope();
		} catch {
			return errorResponse(new HttpError(503, "Service Unavailable"));
		}

		let response: Response;
		try {
			response = await handle(scope);
		} catch (error) {
			response = errorResponse(error);
		}

		return this.disposeScopeAfterResponse(response, scope);
	}

	private async dispatch(request: Request, scope: ServiceScope): Promise<Response> {
		const url = new URL(request.url);
		const method = request.method.toUpperCase() as HttpMethod;

		for (const route of this.routes) {
			if (route.method !== method) {
				continue;
			}

			const match = route.matcher.exec(url.pathname);
			if (!match) {
				continue;
			}

			const params: Record<string, string> = {};
			for (const [index, name] of route.parameterNames.entries()) {
				try {
					params[name] = decodeURIComponent(match[index + 1] ?? "");
				} catch (cause) {
					throw new HttpError(400, "Invalid route parameter", { cause });
				}
			}

			const context = this.createContext(request, params, scope);
			const result = await invokeTarget(route.target, context);

			return toResponse(result);
		}

		return Response.json({ error: "Not Found" }, { status: 404 });
	}

	private createContext(
		request: Request,
		params: Readonly<Record<string, string>>,
		scope: ServiceScope,
	): HttpRequestContext {
		return {
			request,
			params: Object.freeze({ ...params }),
			services: Object.freeze({
				get: <T>(token: ServiceToken<T>): T => scope.get(token),
			}),
		};
	}
}

async function withRouteRegistration<T>(loadModules: () => Promise<T>): Promise<T> {
	const previousImport = routeRegistry.importQueue;
	let releaseImport!: () => void;
	routeRegistry.importQueue = new Promise<void>((resolveImport) => {
		releaseImport = resolveImport;
	});
	await previousImport;

	try {
		return await loadModules();
	} finally {
		routeRegistry.activeDefinitions = undefined;
		releaseImport();
	}
}

function validateUniqueRoutes(routes: readonly RouteDefinition[]): void {
	const seenRoutes = new Set<string>();
	for (const route of routes) {
		const key = `${route.method} ${canonicalizePath(route.path)}`;
		if (seenRoutes.has(key)) {
			throw new Error(`Duplicate HTTP route matcher: ${key}`);
		}

		seenRoutes.add(key);
	}
}

function canonicalizePath(path: string): string {
	const segments = path.split("/").map((segment) => (segment.startsWith(":") ? ":" : segment));

	if (segments.length > 1 && segments.at(-1) === "") {
		segments.pop();
	}

	return segments.join("/");
}

function compareRouteSpecificity(left: RouteDefinition, right: RouteDefinition): number {
	const leftSegments = left.path.split("/");
	const rightSegments = right.path.split("/");
	const segmentCount = Math.min(leftSegments.length, rightSegments.length);

	for (let index = 0; index < segmentCount; index++) {
		const leftIsParameter = leftSegments[index]?.startsWith(":") ?? false;
		const rightIsParameter = rightSegments[index]?.startsWith(":") ?? false;

		if (leftIsParameter !== rightIsParameter) {
			return leftIsParameter ? 1 : -1;
		}
	}

	return rightSegments.length - leftSegments.length;
}

async function invokeTarget(
	target: HttpRouteTarget,
	context: HttpRequestContext,
): Promise<unknown> {
	if (typeof target === "function") {
		return target(context);
	}

	const [controllerToken, methodName] = target;
	const controller = context.services.get(controllerToken);
	const handler = (controller as Record<string, unknown>)[methodName];
	if (typeof handler !== "function") {
		throw new Error(`HTTP controller method is not callable: ${methodName}`);
	}

	return handler.call(controller, context);
}

function toResponse(value: unknown): Response {
	if (value instanceof Response) {
		return value;
	}
	if (value === undefined || value === null) {
		return new Response(null, { status: 204 });
	}
	if (typeof value === "string") {
		return new Response(value, { headers: { "content-type": "text/plain; charset=utf-8" } });
	}

	return Response.json(value);
}

function errorResponse(error: unknown): Response {
	if (error instanceof HttpError) {
		const message = error.expose ? error.message : "Internal Server Error";

		return Response.json({ error: message }, { status: error.status });
	}

	return Response.json({ error: "Internal Server Error" }, { status: 500 });
}

function readRouteModules(value: unknown): Record<string, string> {
	if (value === undefined) {
		return {};
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("HTTP profile routes must be a table of module paths");
	}

	const paths: Record<string, string> = {};
	for (const [name, path] of Object.entries(value)) {
		if (typeof path !== "string" || !path.trim()) {
			throw new Error(`HTTP route module "${name}" must be a non-empty path`);
		}

		paths[name] = path;
	}

	return paths;
}

function compilePath(path: string): { matcher: RegExp; parameterNames: string[] } {
	if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
		throw new Error(`Invalid HTTP route path: ${path}`);
	}

	const parameterNames: string[] = [];
	const segments = path.split("/").map((segment) => {
		if (!segment.startsWith(":")) {
			return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}

		const name = segment.slice(1);
		if (!/^[A-Za-z_][A-Za-z\d_]*$/.test(name) || parameterNames.includes(name)) {
			throw new Error(`Invalid HTTP route parameter in path: ${path}`);
		}

		parameterNames.push(name);

		return "([^/]+)";
	});

	return {
		matcher: new RegExp(`^${segments.join("/")}/?$`),
		parameterNames,
	};
}
