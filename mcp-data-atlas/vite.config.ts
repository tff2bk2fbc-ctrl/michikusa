import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const input = process.env.INPUT;
if (!input) {
  throw new Error("INPUT environment variable is not set");
}

const isDevelopment = process.env.NODE_ENV === "development";

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    sourcemap: false,
    cssMinify: !isDevelopment,
    minify: !isDevelopment,
    rollupOptions: { input },
    outDir: "dist",
    emptyOutDir: false,
  },
});
