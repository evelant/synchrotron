// Sync package test setup
import "blob-polyfill"

// This file is imported by vitest before running tests for the sync package
// It sets up the necessary polyfills for vector extension support

console.log(
	"Loaded blob-polyfill from packages/sync/vitest-setup.ts for vector extension support in sync package tests"
)
