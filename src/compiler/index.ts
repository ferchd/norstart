import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parseConfiguration } from "../core/configuration.ts";
import { createManifest } from "../core/manifest.ts";
import type { ApplicationConfig } from "../core/contracts.ts";
import { ServiceAnalyzer } from "./analyzer.ts";
import { quoteCodeString } from "./code-string.ts";
import { validateProfileDrivers } from "./profile-drivers.ts";
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
	const driverFiles: string[] = [];
	for (const specifier of application.config.application.profileDrivers ?? []) {
		const moduleFile = resolveDriverModule(specifier, application.root);
		if (!moduleFile) {
			throw new Error(`Profile driver module not found: ${specifier}`);
		}
		if (!/[\\/]node_modules[\\/]/.test(moduleFile)) {
			explicitFiles.push(moduleFile);
		}
		driverFiles.push(moduleFile);
	}
	const completeProject = readApplicationProject(
		application.root,
		explicitFiles,
		application.manifestPath,
	);
	const extensionFiles = (application.config.application.extensions ?? []).map((specifier) => {
		const file = resolveDriverModule(specifier, application.root);
		if (!file) {
			throw new Error(`Extension module not found: ${specifier}`);
		}

		return file;
	});
	const analyzer = new ServiceAnalyzer(
		completeProject.files,
		completeProject.options,
		application.root,
		extensionFiles,
	);
	analyzer.validateRouteModules(application.routeFiles);
	const extensions = analyzer.analyzeExtensions(extensionFiles);
	const services = analyzer.analyze(
		application.files,
		extensions.flatMap((extension) => extension.providers),
	);
	validateApplicationTypes(analyzer.program, application.root, completeProject.files);
	validateProfileDrivers(
		application.config.application.profileDrivers ?? [],
		application.root,
		completeProject.options,
	);

	return { ...application, analyzer, services, driverFiles, extensions };
}

function resolveDriverModule(specifier: string, root: string): string | undefined {
	try {
		return Bun.resolveSync(specifier, root);
	} catch {
		return undefined;
	}
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
	const extensionDefinitions = application.extensions.map((extension, index) => {
		const providers = extension.providers.map((provider) => {
			return [
				"\t\t\t\tObject.freeze({",
				`\t\t\t\t\ttoken: ${reference(provider.token)},`,
				`\t\t\t\t\tuseClass: ${reference(provider.implementation)},`,
				"\t\t\t\t\tinject: Object.freeze([",
				...provider.inject.map((token) => `\t\t\t\t\t\t${reference(token)},`),
				"\t\t\t\t\t]),",
				`\t\t\t\t\tlifetime: ${quoteCodeString(provider.lifetime)},`,
				"\t\t\t\t}),",
			].join("\n");
		});
		const alias = `extensionDefinition${index}`;

		return [
			"\t\tObject.freeze({",
			`\t\t\tname: ${quoteCodeString(extension.name)},`,
			`\t\t\tdependencies: ${frozenLiteral(extension.dependencies, 3)},`,
			"\t\t\tproviders: Object.freeze([",
			...providers,
			"\t\t\t]),",
			`\t\t\tregister: ${alias}.register?.bind(${alias}),`,
			`\t\t\tinitialize: ${alias}.initialize?.bind(${alias}),`,
			`\t\t\tshutdown: ${alias}.shutdown?.bind(${alias}),`,
			"\t\t}),",
		].join("\n");
	});
	const profileDriverImports = application.driverFiles.map((driverFile, index) => {
		const source = importPath(manifestPath, driverFile);

		return {
			alias: `profileDriver${index}`,
			path: quoteCodeString(source),
		};
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
		application: {
			name: application.config.application.name,
			serviceModules: [],
			profileDrivers: application.config.application.profileDrivers ?? [],
			extensions: application.config.application.extensions ?? [],
		},
		profiles,
	};
	const manifest = createManifest(config);
	const lines = [
		...application.extensions.map(
			(extension, index) =>
				`import * as extensionModule${index} from ${quoteCodeString(importPath(manifestPath, extension.file))};`,
		),
		...profileDriverImports.map(({ alias, path }) => `import * as ${alias} from ${path};`),
		...routeImports,
		'import type { ApplicationExtension, CompiledApplicationDefinition } from "norstar/core";',
		...[...imports].map(
			([file, alias]) =>
				`import * as ${alias} from ${quoteCodeString(importPath(manifestPath, file))};`,
		),
		"",
		...application.extensions.map(
			(_extension, index) =>
				`const extensionDefinition${index} = extensionModule${index}.default as ApplicationExtension;`,
		),
		`const definition: CompiledApplicationDefinition = {`,
		`\tconfig: ${frozenLiteral(config, 1)},`,
		`\tmanifest: ${frozenLiteral(manifest, 1)},`,
		`\tdrivers: Object.freeze([${profileDriverImports.map(({ alias }) => `${alias}.default`).join(", ")}]),`,
		"\textensions: Object.freeze([",
		...extensionDefinitions,
		"\t]),",
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
