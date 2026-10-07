import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  auth: true,
  buckets: {
    assets: {},
  },
  functions: {
    api: {
      name: "Nabaha secure API",
      source: "src/api.ts",
    },
  },
});
