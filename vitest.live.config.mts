import { defineConfig } from "vitest/config";

// Throwaway config for the live provider smoke only. Not used by `yarn test`.
export default defineConfig({
  test: {
    hookTimeout: 120_000,
    include: ["scripts/provider-smoke.live.ts"],
    testTimeout: 120_000,
  },
});
