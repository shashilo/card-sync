import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const packageJson = JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf8"));

function syncExtensionVersion() {
  return {
    name: "sync-extension-version",
    async closeBundle() {
      const manifestPath = resolve(rootDir, "dist/manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.version = packageJson.version;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  };
}

export default defineConfig({
  plugins: [react(), syncExtensionVersion()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(rootDir, "sidepanel.html"),
        options: resolve(rootDir, "options.html"),
        background: resolve(rootDir, "src/background/service-worker.ts"),
        contentScript: resolve(rootDir, "src/content/content-script.ts")
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "background") return "background.js";
          if (chunk.name === "contentScript") return "content-script.js";
          return "assets/[name].js";
        },
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  }
});
