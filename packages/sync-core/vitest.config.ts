import { defineProject } from "vitest/config"
import shared from "../../vitest.shared"

export default defineProject({
  ...shared,
  test: {
    name: "sync-core",
    // Add any specific test configurations for sync-core here
    // e.g., setupFiles: ["./vitest-setup.ts"]
  }
})