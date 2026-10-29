import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

export default defineConfig({
	files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
	ignores: ["node_modules/**", "dist/**", "coverage/**", ".husky/_/**"],
	extends: [js.configs.recommended, tseslint.configs.recommended],
	plugins: {
		"@stylistic": stylistic,
	},
	languageOptions: {
		globals: {
			...globals.node,
			Bun: "readonly",
		},
	},
	rules: {
		curly: ["error", "all"],
		"@stylistic/brace-style": ["error", "1tbs", { allowSingleLine: false }],
		"@stylistic/indent": ["error", "tab", { SwitchCase: 1 }],
		"@stylistic/max-statements-per-line": ["error", { max: 1 }],
		"@stylistic/padding-line-between-statements": [
			"error",
			{ blankLine: "always", prev: "*", next: "return" },
		],
	},
});
