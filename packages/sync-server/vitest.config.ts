import { defineProject } from "vitest/config"
import shared from "../../vitest.shared"

export default defineProject({
  ...shared,
  test: {
    name: "sync-server",
    // Add any specific test configurations for sync-server here
    // e.g., setupFiles: ["./vitest-setup.ts"]
  }
})