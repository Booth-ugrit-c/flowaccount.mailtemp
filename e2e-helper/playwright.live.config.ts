import { defineConfig } from "@playwright/test";

export default defineConfig({
  testMatch: "live-smoke.spec.ts",
  timeout: 60_000,
  reporter: "list",
});
