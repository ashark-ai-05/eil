import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["ts/tests/**/*.test.ts"],
    // DB test files create/drop their own databases; run files sequentially
    // so admin operations never race.
    fileParallelism: false,
    // PGlite (WASM) cold-start + running all migrations in a beforeAll is
    // legitimately slow, especially the pglite lock test that spins up several
    // instances; the 10s default hookTimeout is too tight under load.
    hookTimeout: 60000,
    testTimeout: 60000,
  },
});
