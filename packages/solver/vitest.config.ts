import { defineConfig } from "vitest/config";

// Restrict discovery to src/**/*.test.ts — without this, vitest also picks up
// compiled *.test.js under the git-ignored dist/, double-running every test
// after a local `npm run build`.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
