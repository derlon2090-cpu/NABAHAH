import dotenv from "dotenv";
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";

dotenv.config({ path: ".env.local" });
if (!process.env.NEON_AUTH_BASE_URL) throw new Error("NEON_AUTH_BASE_URL is required to build admin sign-in.");
await build({
  entryPoints: ["nabaha-site/admin-src.js"],
  outfile: "nabaha-site/dist/admin.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
});
const config = {
  authUrl: process.env.NEON_AUTH_BASE_URL,
  apiUrl: process.env.NABAHA_FUNCTION_URL ?? process.env.NEON_FUNCTION_API_BASE_URL ?? "",
};
await writeFile("nabaha-site/dist/admin-config.js", `window.NABAHA_CONFIG=${JSON.stringify(config)};\n`, "utf8");
console.log("Admin dashboard assets built; only public endpoint URLs are embedded.");
