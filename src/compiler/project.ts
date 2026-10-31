import ts from "typescript";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface ApplicationProject {
	readonly files: readonly string[];
	readonly options: ts.CompilerOptions;
}

export function readApplicationProject(
	root: string,
	explicitFiles: readonly string[],
	manifestPath: string,
): ApplicationProject {
	const configPath = resolve(root, "tsconfig.json");
	let files: readonly string[];
	let options: ts.CompilerOptions = {};
	const hasConfig = ts.sys.fileExists(configPath);
	if (hasConfig) {
		const configuration = ts.readConfigFile(configPath, ts.sys.readFile);
		if (configuration.error) {
			throwDiagnostics([configuration.error], root);
		}

		const parsed = ts.parseJsonConfigFileContent(
			configuration.config,
			ts.sys,
			root,
			undefined,
			configPath,
		);
		throwDiagnostics(parsed.errors, root);
		files = parsed.fileNames.filter((file) => !isGeneratedFile(root, manifestPath, file));
		options = parsed.options;
	} else {
		files = ts.sys.readDirectory(
			resolve(root, "src"),
			[".ts", ".tsx", ".mts", ".cts"],
			["**/node_modules/**", "**/.norstar/**"],
			["**/*"],
		);
	}
	const ambientTypes = ["bun", "node"].filter(
		(name) =>
			ts.resolveTypeReferenceDirective(
				name,
				resolve(root, "application.ts"),
				{ ...options, configFilePath: configPath },
				ts.sys,
			).resolvedTypeReferenceDirective !== undefined,
	);

	return {
		files: [...new Set([...files, ...explicitFiles].map((file) => resolve(file)))],
		options: {
			module: ts.ModuleKind.Preserve,
			moduleDetection: ts.ModuleDetectionKind.Force,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			target: ts.ScriptTarget.ESNext,
			allowImportingTsExtensions: true,
			allowJs: true,
			strict: hasConfig ? undefined : true,
			types: ambientTypes.length > 0 ? ambientTypes : undefined,
			configFilePath: configPath,
			skipLibCheck: true,
			...options,
			noEmit: true,
		},
	};
}

export function isGeneratedFile(root: string, manifestPath: string, file: string): boolean {
	const path = relative(resolve(root, ".norstar"), resolve(file));
	if (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)) {
		return true;
	}

	const output = normalizePath(manifestPath);
	const candidate = normalizePath(file);
	if (candidate === output) {
		return true;
	}
	if (!candidate.startsWith(output)) {
		return false;
	}

	return /^\.route-\d+(?:\.prelude)?\.ts$/.test(candidate.slice(output.length));
}

function normalizePath(path: string): string {
	const normalized = resolve(path);

	return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

export function validateApplicationTypes(
	program: ts.Program,
	root: string,
	explicitFiles: readonly string[],
): void {
	const roots = new Set(explicitFiles.map((file) => resolve(file)));
	const frameworkDirectory = fileURLToPath(new URL("../", import.meta.url));
	const diagnostics = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
	for (const source of program.getSourceFiles()) {
		const explicit = roots.has(resolve(source.fileName));
		if (
			program.isSourceFileDefaultLibrary(source) ||
			(!explicit && program.isSourceFileFromExternalLibrary(source))
		) {
			continue;
		}

		const frameworkPath = relative(frameworkDirectory, source.fileName);
		const frameworkDependency =
			!isAbsolute(frameworkPath) &&
			frameworkPath !== ".." &&
			!frameworkPath.startsWith(`..${sep}`);
		if (frameworkDependency && !explicit) {
			continue;
		}

		diagnostics.push(
			...program.getSyntacticDiagnostics(source),
			...program.getSemanticDiagnostics(source),
		);
	}
	throwDiagnostics(diagnostics, root);
}

function throwDiagnostics(diagnostics: readonly ts.Diagnostic[], root: string): void {
	const errors = diagnostics.filter(
		(diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
	);
	if (errors.length === 0) {
		return;
	}

	throw new Error(
		ts.formatDiagnostics(errors, {
			getCanonicalFileName: (file) => file,
			getCurrentDirectory: () => root,
			getNewLine: () => "\n",
		}),
	);
}
