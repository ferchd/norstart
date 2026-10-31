import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ServiceLifetime, ServiceResolver, ServiceToken } from "./contracts.ts";
import { Container } from "./container.ts";

interface InjectableServiceDefinition {
	readonly lifetime: ServiceLifetime;
	readonly inject: readonly ServiceToken<unknown>[];
	readonly token?: ServiceToken<unknown>;
}

interface InjectableServiceClass {
	readonly norstarService: unknown;
	new (...arguments_: never[]): object;
}

export async function registerServiceModules(
	modulePaths: readonly string[],
	services: Container,
	signal: AbortSignal,
): Promise<void> {
	for (const modulePath of modulePaths) {
		if (signal.aborted) {
			return;
		}

		const absolutePath = resolve(modulePath);
		let moduleExports: Record<string, unknown> | undefined;
		let onAbort!: () => void;
		const cancelled = new Promise<undefined>((resolveCancellation) => {
			onAbort = () => resolveCancellation(undefined);
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			moduleExports = await Promise.race([
				import(pathToFileURL(absolutePath).href),
				cancelled,
			]);
		} catch (cause) {
			if (signal.aborted) {
				return;
			}

			throw new Error(`Unable to load service module "${absolutePath}"`, { cause });
		} finally {
			signal.removeEventListener("abort", onAbort);
		}

		if (signal.aborted || moduleExports === undefined) {
			return;
		}

		for (const [exportName, exported] of Object.entries(moduleExports)) {
			if (signal.aborted) {
				return;
			}

			if (!isInjectableServiceClass(exported)) {
				continue;
			}

			const definition = readDefinition(exported.norstarService, absolutePath, exportName);
			const token = definition.token ?? (exported as unknown as ServiceToken<object>);
			if (signal.aborted) {
				return;
			}

			services.register(
				token,
				(resolver) => instantiate(exported, definition, resolver),
				definition.lifetime,
			);
		}
	}
}

function isInjectableServiceClass(value: unknown): value is InjectableServiceClass {
	return typeof value === "function" && "norstarService" in value;
}

function readDefinition(
	value: unknown,
	modulePath: string,
	exportName: string,
): InjectableServiceDefinition {
	if (typeof value !== "object" || value === null) {
		throw new Error(`Service metadata is invalid for ${exportName} in "${modulePath}"`);
	}

	const definition = value as Record<string, unknown>;
	const validLifetimes: readonly string[] = ["singleton", "transient", "scoped"];
	if (
		!validLifetimes.includes(String(definition.lifetime)) ||
		!Array.isArray(definition.inject) ||
		!definition.inject.every(isServiceToken) ||
		(definition.token !== undefined && !isServiceToken(definition.token))
	) {
		throw new Error(`Service metadata is invalid for ${exportName} in "${modulePath}"`);
	}

	return {
		lifetime: definition.lifetime as ServiceLifetime,
		inject: definition.inject,
		token: definition.token as ServiceToken<unknown> | undefined,
	};
}

function isServiceToken(value: unknown): value is ServiceToken<unknown> {
	return typeof value === "symbol" || typeof value === "function";
}

function instantiate(
	serviceClass: InjectableServiceClass,
	definition: InjectableServiceDefinition,
	resolver: ServiceResolver,
): object {
	const dependencies = definition.inject.map((token) => resolver.get(token));

	return Reflect.construct(serviceClass, dependencies) as object;
}
