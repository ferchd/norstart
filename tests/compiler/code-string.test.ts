import { expect, test } from "bun:test";
import ts from "typescript";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quoteCodeString } from "../../src/compiler/code-string.ts";
import { compileApplication } from "../../src/compiler/index.ts";
import { withTemporaryDirectory } from "../core/helpers.ts";

test("quotes generated code strings without changing their parsed value", () => {
	const value = '"quoted" \\ path\n</script><script>alert("value")</script>\u2028\u2029';
	const quoted = quoteCodeString(value);
	expect(quoted).not.toMatch(/[<>\u2028\u2029]/u);
	expect(quoted).toContain("\\u003c");
	expect(quoted).toContain("\\u003e");
	expect(quoted).toContain("\\u2028");
	expect(quoted).toContain("\\u2029");
	const parsed = ts.createSourceFile(
		"literal.ts",
		`const value = ${quoted};`,
		ts.ScriptTarget.ESNext,
		true,
	);
	const statement = parsed.statements[0];
	if (!statement || !ts.isVariableStatement(statement)) {
		throw new Error("Expected one variable declaration");
	}
	const initializer = statement.declarationList.declarations[0]?.initializer;
	if (!initializer || !ts.isStringLiteral(initializer)) {
		throw new Error("Expected a quoted string initializer");
	}
	expect(initializer.text).toBe(value);
});

test("escapes exported service aliases and configuration strings in generated artifacts", async () => {
	await withTemporaryDirectory(async (directory) => {
		const alias = "</script>\u2028\u2029";
		await writeFile(
			join(directory, "services.ts"),
			`class Service {}\nexport { Service as ${quoteCodeString(alias)} };\n`,
		);
		await writeFile(
			join(directory, "framework.toml"),
			'[application]\nserviceModules = ["services.ts"]\nname = "</script>"\n[profiles.job]\ntype = "worker"',
		);
		const { manifestPath } = await compileApplication({ rootDirectory: directory });
		const generated = await readFile(manifestPath, "utf8");
		expect(generated).not.toContain("</script>");
		const parsed = ts.createSourceFile("manifest.ts", generated, ts.ScriptTarget.ESNext, true);
		const strings: string[] = [];
		const collect = (node: ts.Node): void => {
			if (ts.isStringLiteral(node)) {
				expect(node.getText(parsed)).not.toMatch(/[<>\u2028\u2029]/u);
				strings.push(node.text);
			}
			ts.forEachChild(node, collect);
		};
		collect(parsed);
		expect(strings).toContain(alias);
		expect(strings).toContain("</script>");
	});
}, 20000);
