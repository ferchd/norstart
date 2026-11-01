import ts from "typescript";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { quoteCodeString } from "./code-string.ts";

/** Validate typed exports without importing or evaluating the driver package. */
export function validateProfileDrivers(
	specifiers: readonly string[],
	root: string,
	options: ts.CompilerOptions,
): void {
	const file = resolve(root, "__norstar_driver_contract__.ts");
	const typed = specifiers.filter((specifier) => {
		const resolution = ts.resolveModuleName(
			specifier,
			file,
			options,
			ts.sys,
			undefined,
			undefined,
			ts.ModuleKind.ESNext,
		).resolvedModule;

		return resolution !== undefined && /\.[cm]?tsx?$/.test(resolution.resolvedFileName);
	});
	if (typed.length === 0) {
		return;
	}

	const contract = fileURLToPath(new URL("../core/contracts.ts", import.meta.url));
	const source = [
		`import type { ProfileDriver } from ${quoteCodeString(contract.replaceAll("\\", "/"))};`,
		...typed.flatMap((specifier, index) => [
			`import driver${index} from ${quoteCodeString(specifier)};`,
			`const checked${index}: ProfileDriver = driver${index};`,
		]),
	].join("\n");
	const host = ts.createCompilerHost(options);
	const getSourceFile = host.getSourceFile.bind(host);
	host.getCurrentDirectory = () => root;
	host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
		if (resolve(path) === file) {
			return ts.createSourceFile(path, source, languageVersion, true);
		}

		return getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
	};
	const program = ts.createProgram(
		[file],
		{
			...options,
			rootDir: undefined,
			composite: false,
			noEmit: true,
			noUnusedLocals: false,
			noCheck: false,
		},
		host,
	);
	const validation = program.getSourceFile(file)!;
	const diagnostics = [
		...program.getSyntacticDiagnostics(validation),
		...program.getSemanticDiagnostics(validation),
	];
	if (diagnostics.length > 0) {
		throw new Error(
			`Invalid profile driver contract:\n${ts.formatDiagnostics(diagnostics, {
				getCanonicalFileName: (path) => path,
				getCurrentDirectory: () => root,
				getNewLine: () => "\n",
			})}`,
		);
	}
}
