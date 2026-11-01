import ts from "typescript";
import { resolve } from "node:path";
import type { ServiceLifetime } from "../core/contracts.ts";
import { quoteCodeString } from "./code-string.ts";

export interface AnalyzedService {
	readonly name: string;
	readonly implementation: ts.Symbol;
	readonly token: ts.Symbol;
	readonly inject: readonly ts.Symbol[];
	readonly lifetime: ServiceLifetime;
}

export interface AnalyzedExtension {
	readonly file: string;
	readonly name: string;
	readonly dependencies: readonly string[];
	readonly providers: readonly AnalyzedService[];
}

export class ServiceAnalyzer {
	readonly program: ts.Program;
	private readonly checker: ts.TypeChecker;

	constructor(
		files: readonly string[],
		options: ts.CompilerOptions = {},
		directory = process.cwd(),
		extensionFiles: readonly string[] = [],
	) {
		const compilerOptions: ts.CompilerOptions = {
			module: ts.ModuleKind.Preserve,
			moduleDetection: ts.ModuleDetectionKind.Force,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			target: ts.ScriptTarget.ESNext,
			allowImportingTsExtensions: true,
			allowJs: true,
			skipLibCheck: true,
			noEmit: true,
			...options,
		};
		const host = ts.createCompilerHost(compilerOptions);
		host.getCurrentDirectory = () => directory;
		const roots = [...files];
		if (extensionFiles.length > 0) {
			let suffix = 0;
			let virtual = resolve(options.rootDir ?? directory, "__norstar_extension_imports__.ts");
			while (host.fileExists(virtual)) {
				suffix++;
				virtual = resolve(
					options.rootDir ?? directory,
					`__norstar_extension_imports_${suffix}__.ts`,
				);
			}
			const source = extensionFiles
				.map((file) => `import ${quoteCodeString(file.replaceAll("\\", "/"))};`)
				.join("\n");
			const getSourceFile = host.getSourceFile.bind(host);
			host.getSourceFile = (file, version, onError, createNew) => {
				if (resolve(file) === virtual) {
					return ts.createSourceFile(file, source, version, true);
				}

				return getSourceFile(file, version, onError, createNew);
			};
			roots.push(virtual);
		}
		this.program = ts.createProgram(roots, compilerOptions, host);
		this.checker = this.program.getTypeChecker();
	}

	analyze(
		files: readonly string[],
		providers: readonly AnalyzedService[] = [],
	): AnalyzedService[] {
		const services: AnalyzedService[] = [];
		const seen = new Set<ts.Symbol>();
		for (const file of files) {
			const source = this.program.getSourceFile(resolve(file));
			if (!source) {
				throw new Error(`Unable to analyze service module: ${file}`);
			}
			const diagnostics = this.program.getSyntacticDiagnostics(source);
			if (diagnostics.length > 0) {
				throw new Error(ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, "\n"));
			}
			const moduleSymbol = this.checker.getSymbolAtLocation(source);
			if (!moduleSymbol) {
				continue;
			}
			for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
				const symbol = this.canonical(exported);
				const declaration = symbol.valueDeclaration;
				if (!declaration || !ts.isClassDeclaration(declaration) || seen.has(symbol)) {
					continue;
				}
				seen.add(symbol);
				services.push(
					this.readService(symbol, declaration, file.endsWith(".controller.ts")),
				);
			}
		}
		this.validate([...services, ...providers]);

		return services;
	}

	analyzeExtensions(files: readonly string[]): AnalyzedExtension[] {
		const extensions = files.map((file) => this.readExtension(file));
		const byName = new Map<string, AnalyzedExtension>();
		for (const extension of extensions) {
			if (byName.has(extension.name)) {
				throw new Error(`Duplicate extension: ${extension.name}`);
			}
			byName.set(extension.name, extension);
		}
		const visited = new Set<string>();
		const visit = (name: string, path: readonly string[]): void => {
			if (path.includes(name)) {
				throw new Error(`Circular extension dependency: ${[...path, name].join(" -> ")}`);
			}
			if (visited.has(name)) {
				return;
			}
			const extension = byName.get(name);
			if (!extension) {
				throw new Error(`Missing extension dependency: ${name}`);
			}
			for (const dependency of extension.dependencies) {
				visit(dependency, [...path, name]);
			}
			visited.add(name);
		};
		for (const name of byName.keys()) {
			visit(name, []);
		}

		return extensions;
	}

	private readExtension(file: string): AnalyzedExtension {
		const source = this.program.getSourceFile(file);
		if (!source || source.isDeclarationFile) {
			throw new Error(`Compiled extensions require runtime source metadata: ${file}`);
		}
		const module = this.checker.getSymbolAtLocation(source);
		const exported =
			module &&
			this.checker.getExportsOfModule(module).find((symbol) => symbol.name === "default");
		const declaration = exported && this.canonical(exported).valueDeclaration;
		let expression: ts.Expression | undefined;
		if (declaration && ts.isExportAssignment(declaration)) {
			expression = declaration.expression;
		} else if (declaration && ts.isVariableDeclaration(declaration)) {
			expression = declaration.initializer;
		}
		if (!expression) {
			throw new Error(`Compiled extension metadata must be static: ${file}`);
		}
		const literal = this.staticExpression(expression);
		if (!ts.isObjectLiteralExpression(literal)) {
			throw new Error(`Compiled extension metadata must be static: ${file}`);
		}
		const properties = new Map<string, ts.Expression>();
		const seen = new Set<string>();
		for (const property of literal.properties) {
			if (!property.name || !ts.isIdentifier(property.name) || seen.has(property.name.text)) {
				throw new Error(`Compiled extension metadata must be static: ${file}`);
			}
			const name = property.name.text;
			seen.add(name);
			if (
				![
					"name",
					"dependencies",
					"providers",
					"register",
					"initialize",
					"shutdown",
				].includes(name)
			) {
				throw new Error(`Unsupported extension metadata property: ${name}`);
			}
			if (["register", "initialize", "shutdown"].includes(name)) {
				if (
					!ts.isMethodDeclaration(property) &&
					!ts.isPropertyAssignment(property) &&
					!ts.isShorthandPropertyAssignment(property)
				) {
					throw new Error(`Invalid extension hook: ${name}`);
				}
				const type = this.checker.getTypeAtLocation(property.name);
				if (
					!(type.flags & ts.TypeFlags.Undefined) &&
					this.checker.getNonNullableType(type).getCallSignatures().length === 0
				) {
					throw new Error(`Invalid extension hook: ${name}`);
				}
				continue;
			}
			if (!ts.isPropertyAssignment(property)) {
				throw new Error(`Compiled extension metadata must be static: ${file}`);
			}
			properties.set(name, unwrap(property.initializer));
		}
		const name = properties.get("name");
		if (!name || !ts.isStringLiteral(name) || !name.text.trim()) {
			throw new Error(`Compiled extension name must be a non-empty string literal: ${file}`);
		}
		const rawDependencies = properties.get("dependencies");
		const dependencies: string[] = [];
		if (rawDependencies) {
			if (!ts.isArrayLiteralExpression(rawDependencies)) {
				throw new Error(`Compiled extension dependencies must be a static array: ${file}`);
			}
			for (const dependency of rawDependencies.elements) {
				if (!ts.isStringLiteral(dependency) || !dependency.text.trim()) {
					throw new Error(
						`Compiled extension dependencies must be string literals: ${file}`,
					);
				}
				dependencies.push(dependency.text);
			}
		}
		const rawProviders = properties.get("providers");
		const providers: AnalyzedService[] = [];
		if (rawProviders) {
			if (!ts.isArrayLiteralExpression(rawProviders)) {
				throw new Error(`Compiled extension providers must be a static array: ${file}`);
			}
			for (const provider of rawProviders.elements) {
				providers.push(this.readProvider(unwrap(provider)));
			}
		}

		return { file, name: name.text, dependencies, providers };
	}

	private staticExpression(
		expression: ts.Expression,
		visited = new Set<ts.Symbol>(),
	): ts.Expression {
		const value = unwrap(expression);
		if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value)) {
			const raw = this.checker.getSymbolAtLocation(value);
			const symbol = raw && this.canonical(raw);
			const declaration = symbol?.valueDeclaration;
			if (
				symbol &&
				!visited.has(symbol) &&
				declaration &&
				ts.isVariableDeclaration(declaration) &&
				declaration.initializer &&
				ts.isVariableDeclarationList(declaration.parent) &&
				declaration.parent.flags & ts.NodeFlags.Const
			) {
				visited.add(symbol);

				return this.staticExpression(declaration.initializer, visited);
			}
		}

		return value;
	}

	private readProvider(expression: ts.Expression): AnalyzedService {
		if (!ts.isObjectLiteralExpression(expression)) {
			throw new Error("Compiled extension provider must be a static literal");
		}
		const values = new Map<string, ts.Expression>();
		for (const property of expression.properties) {
			if (
				!ts.isPropertyAssignment(property) ||
				!ts.isIdentifier(property.name) ||
				!["token", "useClass", "inject", "lifetime"].includes(property.name.text) ||
				values.has(property.name.text)
			) {
				throw new Error("Unsupported extension provider metadata");
			}
			values.set(property.name.text, unwrap(property.initializer));
		}
		const tokenValue = values.get("token");
		const implementationValue = values.get("useClass");
		const injectValue = values.get("inject");
		const lifetimeValue = values.get("lifetime");
		if (
			!tokenValue ||
			!implementationValue ||
			!injectValue ||
			!ts.isArrayLiteralExpression(injectValue) ||
			!lifetimeValue ||
			!ts.isStringLiteral(lifetimeValue) ||
			!["singleton", "transient", "scoped"].includes(lifetimeValue.text)
		) {
			throw new Error("Invalid static extension provider metadata");
		}
		const token = this.readToken(tokenValue);
		const implementation = this.readToken(implementationValue);
		const declaration = implementation.valueDeclaration;
		if (
			!declaration ||
			!ts.isClassDeclaration(declaration) ||
			declaration.getSourceFile().isDeclarationFile ||
			declaration.heritageClauses?.some(
				(clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
			) ||
			declaration.modifiers?.some(
				(modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword,
			)
		) {
			throw new Error(
				`Extension provider requires an exported concrete runtime class: ${implementation.name}`,
			);
		}
		const inject = injectValue.elements.map((element) => this.readToken(element));
		this.validateConstructor(implementation, declaration, inject);
		this.reference(implementation);
		this.reference(token);

		return {
			name: implementation.name,
			implementation,
			token,
			inject,
			lifetime: lifetimeValue.text as ServiceLifetime,
		};
	}

	validateRouteModules(files: readonly string[]): void {
		const visited = new Set<ts.SourceFile>();
		const visit = (source: ts.SourceFile): void => {
			if (visited.has(source) || source.isDeclarationFile) {
				return;
			}
			visited.add(source);
			const scan = (node: ts.Node): void => {
				if (ts.isFunctionLike(node)) {
					return;
				}
				if (
					ts.isAwaitExpression(node) ||
					(ts.isForOfStatement(node) && node.awaitModifier)
				) {
					throw new Error(
						`Compiled HTTP route modules cannot use top-level await: ${source.fileName}`,
					);
				}
				if (
					(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
					node.moduleSpecifier
				) {
					const symbol = this.checker.getSymbolAtLocation(node.moduleSpecifier);
					for (const declaration of symbol?.declarations ?? []) {
						if (ts.isSourceFile(declaration)) {
							visit(declaration);
						}
					}
				}
				ts.forEachChild(node, scan);
			};
			scan(source);
		};
		for (const file of files) {
			const source = this.program.getSourceFile(file);
			if (source) {
				visit(source);
			}
		}
	}

	reference(symbol: ts.Symbol): { file: string; name: string } {
		for (const declaration of symbol.declarations ?? []) {
			const source = declaration.getSourceFile();
			if (source.isDeclarationFile) {
				throw new Error(
					`Compiled service references require runtime source: ${symbol.name}`,
				);
			}
			const moduleSymbol = this.checker.getSymbolAtLocation(source);
			if (!moduleSymbol) {
				continue;
			}
			for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
				if (this.canonical(exported) === symbol) {
					return { file: source.fileName, name: exported.name };
				}
			}
		}
		throw new Error(`Service token must be exported: ${symbol.name}`);
	}

	private canonical(symbol: ts.Symbol): ts.Symbol {
		return symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
	}

	private symbol(expression: ts.Node, visited = new Set<ts.Symbol>()): ts.Symbol {
		const value = this.checker.getSymbolAtLocation(expression);
		if (!value) {
			throw new Error(`Unable to resolve service dependency: ${expression.getText()}`);
		}

		const symbol = this.canonical(value);
		if (visited.has(symbol)) {
			throw new Error(`Circular token alias: ${symbol.name}`);
		}
		visited.add(symbol);
		const declaration = symbol.valueDeclaration;
		if (declaration && ts.isVariableDeclaration(declaration)) {
			if (
				!ts.isVariableDeclarationList(declaration.parent) ||
				!(declaration.parent.flags & ts.NodeFlags.Const)
			) {
				throw new Error(`Service tokens must be const declarations: ${symbol.name}`);
			}
			const initializer = declaration.initializer && unwrap(declaration.initializer);
			if (
				initializer &&
				(ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer))
			) {
				return this.symbol(initializer, visited);
			}
			if (
				!initializer ||
				!ts.isCallExpression(initializer) ||
				!ts.isIdentifier(initializer.expression) ||
				initializer.expression.text !== "Symbol" ||
				!(this.checker.getTypeAtLocation(declaration).flags & ts.TypeFlags.ESSymbolLike)
			) {
				throw new Error(
					`Service token must be a class or exported Symbol() constant: ${symbol.name}`,
				);
			}
		}

		return symbol;
	}

	private readService(
		symbol: ts.Symbol,
		declaration: ts.ClassDeclaration,
		controller: boolean,
	): AnalyzedService {
		if (
			declaration.heritageClauses?.some(
				(clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
			) ||
			declaration.modifiers?.some(
				(modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword,
			)
		) {
			throw new Error(
				`Compiled services must be concrete classes without inheritance: ${symbol.name}`,
			);
		}
		const metadata = declaration.members.find(
			(member) => member.name?.getText() === "norstarService",
		);
		let lifetime: ServiceLifetime = controller ? "scoped" : "transient";
		let token = symbol;
		let inject: ts.Symbol[];
		if (metadata) {
			if (
				!ts.isPropertyDeclaration(metadata) ||
				!metadata.modifiers?.some(
					(modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
				) ||
				!metadata.initializer
			) {
				throw new Error(`Service metadata must be a static literal: ${symbol.name}`);
			}
			const literal = unwrap(metadata.initializer);
			if (!ts.isObjectLiteralExpression(literal)) {
				throw new Error(`Service metadata must be a static literal: ${symbol.name}`);
			}
			const properties = new Map<string, ts.Expression>();
			for (const property of literal.properties) {
				if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
					throw new Error(`Unsupported service metadata: ${symbol.name}`);
				}
				if (
					properties.has(property.name.text) ||
					!["lifetime", "inject", "token"].includes(property.name.text)
				) {
					throw new Error(`Unsupported service metadata property: ${property.name.text}`);
				}
				properties.set(property.name.text, unwrap(property.initializer));
			}
			const lifetimeValue = properties.get("lifetime");
			const injectValue = properties.get("inject");
			if (
				!lifetimeValue ||
				!ts.isStringLiteral(lifetimeValue) ||
				!["singleton", "scoped", "transient"].includes(lifetimeValue.text) ||
				!injectValue ||
				!ts.isArrayLiteralExpression(injectValue)
			) {
				throw new Error(`Invalid static service metadata: ${symbol.name}`);
			}
			lifetime = lifetimeValue.text as ServiceLifetime;
			inject = injectValue.elements.map((element) => this.readToken(element));
			const tokenValue = properties.get("token");
			if (tokenValue) {
				token = this.readToken(tokenValue);
			}
		} else {
			const constructor = declaration.members.find(ts.isConstructorDeclaration);
			inject = (constructor?.parameters ?? []).map((parameter) => {
				if (
					!parameter.type ||
					!ts.isTypeReferenceNode(parameter.type) ||
					parameter.dotDotDotToken
				) {
					throw new Error(
						`Constructor dependency requires a class type: ${symbol.name}.${parameter.name.getText()}`,
					);
				}

				return this.symbol(parameter.type.typeName);
			});
		}
		const constructor = declaration.members.find(ts.isConstructorDeclaration);
		if (!constructor && inject.length > 0) {
			throw new Error(`Service dependency count does not match constructor: ${symbol.name}`);
		}
		if (constructor) {
			const required = constructor.parameters.filter(
				(parameter) => !parameter.questionToken && !parameter.initializer,
			).length;
			if (
				constructor.parameters.some((parameter) => parameter.dotDotDotToken) ||
				inject.length < required ||
				inject.length > constructor.parameters.length
			) {
				throw new Error(
					`Service dependency count does not match constructor: ${symbol.name}`,
				);
			}
		}
		this.reference(symbol);
		this.reference(token);

		return { name: symbol.name, implementation: symbol, token, inject, lifetime };
	}

	private readToken(expression: ts.Expression): ts.Symbol {
		const value = unwrap(expression);
		if (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value)) {
			throw new Error(`Service tokens must be static references: ${value.getText()}`);
		}

		return this.symbol(value);
	}

	private validateConstructor(
		symbol: ts.Symbol,
		declaration: ts.ClassDeclaration,
		inject: readonly ts.Symbol[],
	): void {
		const constructor = declaration.members.find(ts.isConstructorDeclaration);
		if (!constructor && inject.length > 0) {
			throw new Error(`Service dependency count does not match constructor: ${symbol.name}`);
		}
		if (constructor) {
			const required = constructor.parameters.filter(
				(parameter) => !parameter.questionToken && !parameter.initializer,
			).length;
			if (
				constructor.parameters.some((parameter) => parameter.dotDotDotToken) ||
				inject.length < required ||
				inject.length > constructor.parameters.length
			) {
				throw new Error(
					`Service dependency count does not match constructor: ${symbol.name}`,
				);
			}
		}
	}

	private validate(services: readonly AnalyzedService[]): void {
		const registrations = new Map<ts.Symbol, AnalyzedService>();
		for (const service of services) {
			if (registrations.has(service.token)) {
				throw new Error(`Duplicate service token: ${service.token.name}`);
			}
			registrations.set(service.token, service);
		}
		const visitedNormal = new Set<AnalyzedService>();
		const visitedSingleton = new Set<AnalyzedService>();
		const walk = (
			service: AnalyzedService,
			path: readonly AnalyzedService[],
			singleton: boolean,
		): void => {
			if (path.includes(service)) {
				throw new Error(
					`Circular service dependency: ${[...path, service].map((entry) => entry.name).join(" -> ")}`,
				);
			}
			if (singleton && service.lifetime === "scoped") {
				throw new Error(
					`Singleton cannot depend on scoped service: ${[...path, service].map((entry) => entry.name).join(" -> ")}`,
				);
			}
			const visited =
				singleton || service.lifetime === "singleton" ? visitedSingleton : visitedNormal;
			if (visited.has(service)) {
				return;
			}

			for (const [index, dependency] of service.inject.entries()) {
				const target = registrations.get(dependency);
				if (!target) {
					throw new Error(
						`Missing service dependency: ${service.name} -> ${dependency.name}`,
					);
				}
				const declaration = service.implementation.valueDeclaration;
				const constructor =
					declaration && ts.isClassDeclaration(declaration)
						? declaration.members.find(ts.isConstructorDeclaration)
						: undefined;
				const parameter = constructor?.parameters[index];
				if (
					parameter &&
					!this.checker.isTypeAssignableTo(
						this.checker.getDeclaredTypeOfSymbol(target.implementation),
						this.checker.getTypeAtLocation(parameter),
					)
				) {
					throw new Error(
						`Service dependency type mismatch: ${service.name}.${parameter.name.getText()} -> ${target.name}`,
					);
				}

				walk(target, [...path, service], singleton || service.lifetime === "singleton");
			}
			visited.add(service);
		};
		for (const service of services) {
			walk(service, [], false);
		}
	}
}

function unwrap(expression: ts.Expression): ts.Expression {
	if (
		ts.isAsExpression(expression) ||
		ts.isSatisfiesExpression(expression) ||
		ts.isParenthesizedExpression(expression)
	) {
		return unwrap(expression.expression);
	}

	return expression;
}
