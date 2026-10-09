import { defineConfig } from "@playwright/test";

export default defineConfig({
  testMatch: "example.spec.ts",
  timeout: 30_000,
  reporter: "list",
});
