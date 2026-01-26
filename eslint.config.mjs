import { includeIgnoreFile } from "@eslint/compat"
import js from "@eslint/js"
import prettier from "eslint-config-prettier"
import globals from "globals"
import { fileURLToPath } from "node:url"
import tseslint from "typescript-eslint"

const gitignorePath = fileURLToPath(new URL("./.gitignore", import.meta.url))

const bunGlobals = {
	Bun: "readonly"
}

export default tseslint.config(
	includeIgnoreFile(gitignorePath),
	{
		ignores: [
			"docs/vendor/**",
			"examples/**",
			"packages/sql-pglite/**",
			".pnpm-store/**",
			".out-of-code-insights/**",
			"**/.expo/**",
			"**/android/**/.cxx/**",
			"**/android/**/build/**",
			"**/ios/Pods/**",
			"**/ios/build/**"
		]
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
				...bunGlobals
			}
		},
		rules: {
			"no-throw-literal": "error",
			"no-await-in-loop": "warn",
			"prefer-const": "warn",
			"require-yield": "warn"
		}
	},
	{
		files: ["**/*.{ts,tsx}"],
		rules: {
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
			"@typescript-eslint/consistent-type-imports": ["warn", { prefer: "type-imports" }],
			"@typescript-eslint/no-import-type-side-effects": "warn",
			"@typescript-eslint/no-non-null-assertion": "off",
			"@typescript-eslint/no-empty-object-type": "off",
			"@typescript-eslint/ban-ts-comment": "warn"
		}
	},
	{
		// Test files
		files: ["**/*.{test,spec}.{ts,tsx}", "**/test/**/*.{ts,tsx}"],
		rules: {
			"@typescript-eslint/no-explicit-any": "off" // Allow any in tests
		}
	},
	prettier
)
