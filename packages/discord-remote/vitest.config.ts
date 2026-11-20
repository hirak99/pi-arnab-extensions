import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run only the TypeScript sources — dist/__tests__ holds stale compiled
    // copies of the same tests, and running both in parallel made them race
    // on the config file (they used to share the real user config).
    include: ["extensions/__tests__/**/*.test.ts"],
  },
});
