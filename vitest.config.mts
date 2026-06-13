import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        "dist/**",
        "test/**",
        "scripts/**",
        "src/**/*.d.ts",
        "src/index.ts",
      ],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
    },
    exclude: ["**/*.live.ts", "**/node_modules/**", "dist/**"],
  },
});
