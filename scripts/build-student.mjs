import dotenv from "dotenv";
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";

dotenv.config({ path: ".env.local" });
if (!process.env.NEON_AUTH_BASE_URL) throw new Error("NEON_AUTH_BASE_URL is required to build student sign-in.");
const apiUrl = process.env.NABAHA_FUNCTION_URL ?? process.env.NEON_FUNCTION_API_BASE_URL;
if (!apiUrl) throw new Error("NABAHA_FUNCTION_URL or NEON_FUNCTION_API_BASE_URL is required to build the student app.");

await build({
  entryPoints: ["web/student.js"],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2022"],
  outfile: "dist/student.js",
  loader: {
    ".woff": "file",
    ".woff2": "file",
    ".ttf": "file",
  },
});

await writeFile("dist/admin-config.js", `window.NABAHA_CONFIG=${JSON.stringify({ authUrl: process.env.NEON_AUTH_BASE_URL, apiUrl })};\n`, "utf8");
console.log("Student assets built with production service endpoints.");
