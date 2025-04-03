import { defineProject } from "vitest/config"
import shared from "../../vitest.shared"

export default defineProject({
  ...shared,
  test: {
    name: "sync-client",
    // Add any specific test configurations for sync-client here
    // e.g., setupFiles: ["./vitest-setup.ts"]
  }
})