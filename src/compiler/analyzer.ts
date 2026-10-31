import ts from "typescript";
import { resolve } from "node:path";
import type { ServiceLifetime } from "../core/contracts.ts";

export interface AnalyzedService {
	readonly name: string;
	readonly implementation: ts.Symbol;
	readonly token: ts.Symbol;
	readonly inject: readonly ts.Symbol[];
	readonly lifetime: ServiceLifetime;
}

export class ServiceAnalyzer {
	readonly program: ts.Program;
	private readonly checker: ts.TypeChecker;

	constructor(
		files: readonly string[],
		options: ts.CompilerOptions = {},
		directory = process.cwd(),
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
		this.program = ts.createProgram([...files], compilerOptions, host);
		this.checker = this.program.getTypeChecker();
	}

	analyze(files: readonly string[]): AnalyzedService[] {
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
		this.validate(services);

		return services;
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
