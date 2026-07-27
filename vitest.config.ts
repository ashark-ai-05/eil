import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["ts/tests/**/*.test.ts"],
    // DB test files create/drop their own databases; run files sequentially
    // so admin operations never race.
    fileParallelism: false,
  },
});
