import { includeIgnoreFile } from "@eslint/compat"
import js from "@eslint/js"
import prettier from "eslint-config-prettier"
import solid from "eslint-plugin-solid/configs/recommended"
import globals from "globals"
import { fileURLToPath } from "node:url"
import ts from "typescript-eslint"

const gitignorePath = fileURLToPath(new URL("./.gitignore", import.meta.url))

// TypeScript-specific rules
const tsRules = {
	"@typescript-eslint/no-explicit-any": "error",
	"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
	"@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
	"@typescript-eslint/no-import-type-side-effects": "error",
	"@typescript-eslint/no-non-null-assertion": "error"
}

// Effect-specific rules
const effectRules = {
	"no-restricted-imports": [
		"error",
		{
			patterns: [
				{
					group: ["effect/*"],
					message: 'Import from "effect" instead.'
				}
			]
		}
	],
	"no-throw-literal": "error",
	"no-await-in-loop": "warn"
}

// Base TypeScript config for type-aware rules
const tsBase = {
	languageOptions: {
		parser: ts.parser,
		parserOptions: {
			project: "./tsconfig.json"
		}
	}
}

export default ts.config(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	{
		files: ["**/*.{ts,tsx}"],
		...tsBase,
		...solid,
		...tsRules,
		...effectRules,
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				project: "tsconfig.json"
			}
		}
	},
	...ts.configs.recommended,
	...ts.configs.strict,
	prettier,
	...solid.configs.prettier,
	{
		ignores: [
			// Config files
			"**/tailwind.config.js",
			"**/vite.config.ts",
			"**/vitest.config.ts",
			"**/playwright.config.ts",
			// Standalone scripts
			"scripts/**/*",
			// Test configs
			"/test/vitest-setup-client.ts"
		]
	},
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node
			}
		}
	},

	{
		// Test files
		files: ["/test/**/*.test.ts", "/test/**/*.spec.ts"],
		...tsBase,
		rules: {
			...tsRules,
			...effectRules,
			"@typescript-eslint/no-explicit-any": "off" // Allow any in tests
		}
	}
)
