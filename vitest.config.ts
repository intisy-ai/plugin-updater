import { defineConfig } from "vitest/config";

// Only this package's own tests (src/) — never the bundled core/ submodule's
// internal tests, which run in their own repo.
export default defineConfig({
  test: { include: ["src/**/*.test.{ts,js}"] },
});
