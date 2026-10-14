import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { resolve } from "node:path";
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          runner: resolve("src/runtime/worker.ts"),
          device: resolve("src/device/worker.ts"),
          web: resolve("src/web/worker.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwind()],
    build: {
      minify: true,
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          web: resolve("src/renderer/web.html"),
        },
      },
    },
  },
});
