import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parseConfiguration } from "../core/configuration.ts";
import { createManifest } from "../core/manifest.ts";
import type { ApplicationConfig } from "../core/contracts.ts";
import { ServiceAnalyzer } from "./analyzer.ts";
import { quoteCodeString } from "./code-string.ts";
import { isGeneratedFile, readApplicationProject, validateApplicationTypes } from "./project.ts";

export interface CompilerOptions {
	readonly entry?: string;
	readonly configPath?: string;
	readonly rootDirectory?: string;
	readonly outFile?: string;
}

export interface CompilationResult {
	readonly manifestPath: string;
}

interface Analysis {
	readonly root: string;
	readonly config: ApplicationConfig;
	readonly files: readonly string[];
	readonly routeFiles: readonly string[];
	readonly manifestPath: string;
}

async function readApplication(options: CompilerOptions): Promise<Analysis> {
	const root = resolve(options.rootDirectory ?? process.cwd());
	const configPath = resolve(root, options.configPath ?? "framework.toml");
	const manifestPath = resolve(root, options.outFile ?? ".norstar/manifest.ts");
	const source = await readFile(configPath, "utf8");
	const config = parseConfiguration(source);
	const raw = Bun.TOML.parse(source) as { application?: { discovery?: unknown } };
	const patterns = raw.application?.discovery ?? [
		"src/**/*.service.ts",
		"src/**/*.controller.ts",
	];
	if (
		!Array.isArray(patterns) ||
		!patterns.every((pattern) => typeof pattern === "string" && pattern.trim())
	) {
		throw new Error("[application].discovery must be an array of non-empty glob patterns");
	}
	const files = new Set(config.application.serviceModules.map((file) => resolve(root, file)));
	for (const pattern of patterns as string[]) {
		for await (const file of new Bun.Glob(pattern).scan({
			cwd: root,
			absolute: true,
			onlyFiles: true,
		})) {
			if (isGeneratedFile(root, manifestPath, file)) {
				continue;
			}

			files.add(resolve(file));
		}
	}
	for (const file of files) {
		if (!(await Bun.file(file).exists())) {
			throw new Error(`Service module not found: ${file}`);
		}
	}
	const routeFiles = new Set<string>();
	for (const profile of Object.values(config.profiles)) {
		if (profile.type !== "http-server" || profile.config.routes === undefined) {
			continue;
		}
		const routes = profile.config.routes;
		if (typeof routes !== "object" || routes === null || Array.isArray(routes)) {
			throw new Error("HTTP routes must be a table of module paths");
		}
		for (const value of Object.values(routes)) {
			if (typeof value !== "string" || !value.trim()) {
				throw new Error("Invalid HTTP route module path");
			}
			const file = resolve(root, value);
			if (!(await Bun.file(file).exists())) {
				throw new Error(`HTTP route module not found: ${file}`);
			}
			routeFiles.add(file);
		}
	}
	frozenLiteral(config);

	return {
		root,
		config,
		files: [...files].sort(),
		routeFiles: [...routeFiles].sort(),
		manifestPath,
	};
}

function importPath(from: string, target: string): string {
	const path = relative(dirname(from), target).replaceAll("\\", "/");

	return path.startsWith(".") ? path : `./${path}`;
}

async function analyze(options: CompilerOptions) {
	const application = await readApplication(options);
	const explicitFiles = [...application.files, ...application.routeFiles];
	if (options.entry) {
		explicitFiles.push(resolve(application.root, options.entry));
	}
	const project = readApplicationProject(
		application.root,
		explicitFiles,
		application.manifestPath,
	);
	const analyzer = new ServiceAnalyzer(project.files, project.options, application.root);
	analyzer.validateRouteModules(application.routeFiles);
	const services = analyzer.analyze(application.files);
	validateApplicationTypes(analyzer.program, application.root, project.files);

	return { ...application, analyzer, services };
}

export async function checkApplication(options: CompilerOptions = {}): Promise<CompilationResult> {
	const application = await analyze(options);

	return { manifestPath: application.manifestPath };
}

export async function compileApplication(
	options: CompilerOptions = {},
): Promise<CompilationResult> {
	const application = await analyze(options);
	const { analyzer, manifestPath, root } = application;
	const imports = new Map<string, string>();
	const reference = (symbol: Parameters<ServiceAnalyzer["reference"]>[0]): string => {
		const value = analyzer.reference(symbol);
		let alias = imports.get(value.file);
		if (!alias) {
			alias = `module${imports.size}`;
			imports.set(value.file, alias);
		}

		return `${alias}[${quoteCodeString(value.name)}]`;
	};
	const registrations = application.services.map((service) => {
		const implementation = reference(service.implementation);
		const token = reference(service.token);
		const dependencies = service.inject.map(
			(dependency) => `resolver.get(${reference(dependency)})`,
		);

		let factory = `\t\t\t() => new ${implementation}(),`;
		if (dependencies.length > 0) {
			factory = [
				"\t\t\t(resolver) =>",
				`\t\t\t\tnew ${implementation}(`,
				...dependencies.map((dependency) => `\t\t\t\t\t${dependency},`),
				"\t\t\t\t),",
			].join("\n");
		}

		return [
			"\t\tservices.register(",
			`\t\t\t${token},`,
			factory,
			`\t\t\t${quoteCodeString(service.lifetime)},`,
			"\t\t);",
		].join("\n");
	});
	const profiles: Record<string, { type: string; config: Readonly<Record<string, unknown>> }> =
		Object.create(null);
	const routeImports: string[] = [];
	const routePaths = new Set<string>();
	for (const [id, profile] of Object.entries(application.config.profiles)) {
		if (profile.type !== "http-server" || profile.config.routes === undefined) {
			profiles[id] = profile;
			continue;
		}
		const rawRoutes = profile.config.routes;
		if (typeof rawRoutes !== "object" || rawRoutes === null || Array.isArray(rawRoutes)) {
			throw new Error("HTTP routes must be a table of module paths");
		}
		const routes: Record<string, string> = Object.create(null);
		for (const [name, value] of Object.entries(rawRoutes)) {
			if (typeof value !== "string" || !value.trim()) {
				throw new Error(`Invalid HTTP route module: ${name}`);
			}
			const absolute = resolve(root, value);
			if (!(await Bun.file(absolute).exists())) {
				throw new Error(`HTTP route module not found: ${absolute}`);
			}
			routes[name] = absolute;
			if (!routePaths.has(absolute)) {
				const index = routePaths.size;
				routePaths.add(absolute);
				const preludePath = `${manifestPath}.route-${index}.prelude.ts`;
				const wrapperPath = `${manifestPath}.route-${index}.ts`;
				await mkdir(dirname(manifestPath), { recursive: true });
				await writeFile(
					preludePath,
					'import { beginCompiledRoutes } from "norstar/http";\n\nbeginCompiledRoutes();\n',
				);
				await writeFile(
					wrapperPath,
					`import ${quoteCodeString(importPath(wrapperPath, preludePath))};\nimport ${quoteCodeString(importPath(wrapperPath, absolute))};\nimport { finishCompiledRoutes } from "norstar/http";\n\nfinishCompiledRoutes(${quoteCodeString(absolute)});\n`,
				);
				routeImports.push(
					`import ${quoteCodeString(importPath(manifestPath, wrapperPath))};`,
				);
			}
		}
		profiles[id] = { type: profile.type, config: { ...profile.config, routes } };
	}
	const config: ApplicationConfig = {
		application: { name: application.config.application.name, serviceModules: [] },
		profiles,
	};
	const manifest = createManifest(config);
	const lines = [
		...routeImports,
		'import type { CompiledApplicationDefinition } from "norstar/core";',
		...[...imports].map(
			([file, alias]) =>
				`import * as ${alias} from ${quoteCodeString(importPath(manifestPath, file))};`,
		),
		"",
		`const definition: CompiledApplicationDefinition = {`,
		`\tconfig: ${frozenLiteral(config, 1)},`,
		`\tmanifest: ${frozenLiteral(manifest, 1)},`,
		"",
		`\tregisterServices(services) {`,
		registrations.join("\n\n"),
		`\t},`,
		`};`,
		"",
		`export default definition;`,
	];
	await mkdir(dirname(manifestPath), { recursive: true });
	await writeFile(manifestPath, `${lines.join("\n")}\n`);

	return { manifestPath };
}

function frozenLiteral(value: unknown, depth = 0): string {
	if (typeof value === "string") {
		return quoteCodeString(value);
	}
	if (value === undefined) {
		return "undefined";
	}
	if (
		value === null ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	) {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return "Object.freeze([])";
		}
		const entries = value.map(
			(entry) => `${"\t".repeat(depth + 1)}${frozenLiteral(entry, depth + 1)},`,
		);

		return `Object.freeze([\n${entries.join("\n")}\n${"\t".repeat(depth)}])`;
	}
	if (
		typeof value === "object" &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
	) {
		const entries = Object.entries(value).map(
			([key, entry]) =>
				`${"\t".repeat(depth + 1)}[${quoteCodeString(key)}]: ${frozenLiteral(entry, depth + 1)},`,
		);
		if (entries.length === 0) {
			return "Object.freeze({})";
		}

		return `Object.freeze({\n${entries.join("\n")}\n${"\t".repeat(depth)}})`;
	}

	throw new Error(
		"Compiled configuration supports only finite JSON-compatible values; TOML dates are unsupported",
	);
}
