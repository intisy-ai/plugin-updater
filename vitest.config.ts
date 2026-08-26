import { defineConfig } from "vitest/config";

// Only this repo's own tests, never a dependency's, which run in their own repos.
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,js}"],
    setupFiles: ["src/__tests__/setup.ts"],
    // Much of this suite drives real git and npm subprocesses, which costs milliseconds on a Linux
    // runner and seconds on Windows: the same suite is 7s in CI and around 370s here, so a single
    // test can exceed the 5s default purely from process spawn. Raised so a local run reports on the
    // code rather than on the machine; CI never approaches it.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Every worker spawns subprocesses of its own, so one per core oversubscribes a developer
    // machine that is also building something and starves vitest's own reporting channel, which ends
    // a run with "Timeout calling onTaskUpdate" rather than anything about the code. A CI runner has
    // fewer cores than this cap, so it is unaffected.
    maxWorkers: 4,
  },
});
