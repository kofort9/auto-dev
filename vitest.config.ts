import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "bugbot/tests/**/*.test.ts",
      "nightshift/tests/**/*.test.ts",
    ],
  },
});
