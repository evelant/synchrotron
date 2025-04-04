import { defineConfig, mergeConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import shared from "../../vite.shared.ts"

export default mergeConfig(
	shared,
	defineConfig({
		plugins: [react()],
		optimizeDeps: {
			exclude: [
				"@electric-sql/experimental",
				"@opentelemetry/semantic-conventions",
				"@effect/experimental/EventJournal",
				"@effect/experimental/RequestResolver",
				"@effect/experimental/Reactivity",
				"@effect/experimental/VariantSchema",
				"@effect/experimental/EventLogEncryption",
				"@effect/experimental/EventLogServer",
				"scheduler",
				"find-my-way-ts",
				"multipasta",
				"msgpackr",
				"cookie",
				"set-cookie-parser",
				"radix-ui",
				"radix-ui/internal",
				"classnames",
				"fast-check"
			]
		}
	})
)
