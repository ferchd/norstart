import { existsSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildOutput } from "bun";
import ts from "typescript";

export interface BundleDependencyReport {
	readonly thirdPartyInputs: readonly Readonly<{ path: string; bytesInOutput: number }>[];
	readonly externalPackages: readonly string[];
	readonly externalFiles: readonly string[];
	readonly nativeImports: readonly string[];
	readonly unresolvedDynamicImports: number;
}

export interface BundleAuditOptions {
	readonly rootDirectory: string;
	/** Bun metafile paths are relative to the bundler's working directory. */
	readonly workingDirectory?: string;
}

const frameworkSources = canonicalPath(fileURLToPath(new URL("../", import.meta.url)));

/** Audit statically resolved contributions; arbitrary dynamic imports are outside this report. */
export async function auditBundleDependencies(
	build: Pick<BuildOutput, "metafile" | "outputs">,
	options: BundleAuditOptions,
): Promise<BundleDependencyReport> {
	const metafile = build.metafile;
	if (!metafile) {
		throw new Error("Dependency audit requires Bun build metadata");
	}
	const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
	const root = canonicalPath(resolve(options.rootDirectory));
	const dependencyRoots = new Set<string>();
	for (const [input, metadata] of Object.entries(metafile.inputs)) {
		const importer = resolve(workingDirectory, input);
		for (const imported of metadata.imports) {
			const specifier = imported.original ?? imported.path;
			const packageRoot = resolvedPackageRoot(importer, specifier);
			if (
				packageRoot &&
				inside(
					relative(packageRoot, canonicalPath(resolve(workingDirectory, imported.path))),
				)
			) {
				dependencyRoots.add(packageRoot);
			}
		}
	}
	const contributions = new Map<string, number>();
	for (const output of Object.values(metafile.outputs)) {
		for (const [input, contribution] of Object.entries(output.inputs)) {
			if (contribution.bytesInOutput > 0) {
				contributions.set(
					input,
					(contributions.get(input) ?? 0) + contribution.bytesInOutput,
				);
			}
		}
	}

	const thirdPartyInputs: { path: string; bytesInOutput: number }[] = [];
	const externalPackages = new Set<string>();
	const externalFiles = new Set<string>();
	const nativeImports = new Set<string>();
	for (const [input, bytesInOutput] of contributions) {
		const lexicalPath = resolve(workingDirectory, input);
		const path = canonicalPath(lexicalPath);
		const frameworkRelative = relative(frameworkSources, path);
		const rootRelative = relative(root, path);
		const frameworkSource = inside(frameworkRelative) && !hasNodeModules(frameworkRelative);
		const applicationSource =
			inside(rootRelative) &&
			!hasNodeModules(lexicalPath) &&
			!hasNodeModules(rootRelative) &&
			![...dependencyRoots].some((dependency) => inside(relative(dependency, path))) &&
			!nestedPackage(path, root);
		if (!frameworkSource && !applicationSource) {
			thirdPartyInputs.push({
				path: relative(root, lexicalPath).replaceAll("\\", "/"),
				bytesInOutput,
			});
		}
	}

	const emittedFiles = new Set(build.outputs.map((output) => canonicalPath(output.path)));
	let unresolvedDynamicImports = 0;
	for (const output of build.outputs) {
		if (!["js", "jsx", "ts", "tsx"].includes(output.loader)) {
			continue;
		}
		const imports = emittedImports(output.path, await output.text());
		unresolvedDynamicImports += imports.unresolved;
		for (const specifier of imports.specifiers) {
			if (isBuiltin(specifier)) {
				nativeImports.add(
					specifier === "bun" ||
						specifier.startsWith("bun:") ||
						specifier.startsWith("node:")
						? specifier
						: `node:${specifier}`,
				);
				continue;
			}
			if (
				specifier.startsWith(".") ||
				isAbsolute(specifier) ||
				specifier.startsWith("file:")
			) {
				const path = specifier.startsWith("file:")
					? fileURLToPath(specifier)
					: resolve(dirname(output.path), specifier);
				if (!emittedFiles.has(canonicalPath(path))) {
					externalFiles.add(specifier);
				}
				continue;
			}
			externalPackages.add(specifier);
		}
	}

	return Object.freeze({
		thirdPartyInputs: Object.freeze(
			thirdPartyInputs
				.sort((left, right) => left.path.localeCompare(right.path))
				.map((input) => Object.freeze(input)),
		),
		externalPackages: Object.freeze([...externalPackages].sort()),
		externalFiles: Object.freeze([...externalFiles].sort()),
		nativeImports: Object.freeze([...nativeImports].sort()),
		unresolvedDynamicImports,
	});
}

export function assertNoStaticThirdPartyDependencies(report: BundleDependencyReport): void {
	const dependencies = [
		...report.thirdPartyInputs.map((input) => input.path),
		...report.externalPackages,
		...report.externalFiles,
	];
	if (dependencies.length > 0) {
		throw new Error(
			`Production bundle contains third-party dependencies: ${dependencies.join(", ")}`,
		);
	}
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function inside(path: string): boolean {
	return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function hasNodeModules(path: string): boolean {
	return path.split(/[\\/]/).includes("node_modules");
}

function nestedPackage(path: string, root: string): boolean {
	let directory = dirname(path);
	while (directory !== root && inside(relative(root, directory))) {
		if (existsSync(join(directory, "package.json"))) {
			return true;
		}
		const parent = dirname(directory);
		if (parent === directory) {
			break;
		}
		directory = parent;
	}

	return false;
}

function resolvedPackageRoot(importer: string, specifier: string): string | undefined {
	if (
		isBuiltin(specifier) ||
		specifier.startsWith(".") ||
		!/^(?:@[\w.-]+\/)?[\w.-]+(?:\/|$)/.test(specifier)
	) {
		return undefined;
	}
	const segments = specifier.split("/");
	const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
	let directory = dirname(importer);
	while (true) {
		const candidate = join(directory, "node_modules", name);
		if (existsSync(candidate)) {
			return canonicalPath(candidate);
		}
		const parent = dirname(directory);
		if (parent === directory) {
			return undefined;
		}
		directory = parent;
	}
}

function emittedImports(file: string, text: string): { specifiers: string[]; unresolved: number } {
	const absoluteFile = resolve(file);
	const source = ts.createSourceFile(
		absoluteFile,
		text,
		ts.ScriptTarget.ESNext,
		true,
		ts.ScriptKind.JS,
	);
	const options: ts.CompilerOptions = {
		allowJs: true,
		noEmit: true,
		noLib: true,
		noResolve: true,
		types: [],
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
	};
	const host = ts.createCompilerHost(options);
	host.getSourceFile = (path) => (resolve(path) === absoluteFile ? source : undefined);
	host.fileExists = (path) => resolve(path) === absoluteFile;
	host.readFile = (path) => (resolve(path) === absoluteFile ? text : undefined);
	const program = ts.createProgram([absoluteFile], options, host);
	const checker = program.getTypeChecker();
	const aliases = new Set<ts.Symbol>();
	const requireReference = (node: ts.Expression): boolean => {
		if (ts.isIdentifier(node)) {
			const symbol = checker.getSymbolAtLocation(node);

			return symbol ? aliases.has(symbol) : node.text === "require";
		}

		return (
			ts.isPropertyAccessExpression(node) &&
			node.name.text === "require" &&
			ts.isMetaProperty(node.expression) &&
			node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
		);
	};
	let changed = true;
	while (changed) {
		changed = false;
		const collect = (node: ts.Node): void => {
			if (
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.initializer &&
				requireReference(node.initializer)
			) {
				const symbol = checker.getSymbolAtLocation(node.name);
				if (symbol && !aliases.has(symbol)) {
					aliases.add(symbol);
					changed = true;
				}
			}
			if (
				ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				ts.isIdentifier(node.left) &&
				requireReference(node.right)
			) {
				const symbol = checker.getSymbolAtLocation(node.left);
				if (symbol && !aliases.has(symbol)) {
					aliases.add(symbol);
					changed = true;
				}
			}
			ts.forEachChild(node, collect);
		};
		collect(source);
	}
	const specifiers: string[] = [];
	let unresolved = 0;
	const visit = (node: ts.Node): void => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		) {
			specifiers.push(node.moduleSpecifier.text);
		}
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				requireReference(node.expression))
		) {
			const argument = node.arguments[0];
			if (argument && ts.isStringLiteralLike(argument)) {
				specifiers.push(argument.text);
			} else {
				unresolved++;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);

	return { specifiers, unresolved };
}
