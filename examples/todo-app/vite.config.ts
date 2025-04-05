import { defineConfig, mergeConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import shared from "../../vite.shared.ts"

export default mergeConfig(
	shared,
	defineConfig({
		plugins: [react()]
		// optimizeDeps is now handled by the shared config (vite.shared.ts)
		// to ensure consistent pre-bundling behavior across the monorepo.
	})
)
