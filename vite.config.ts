import { defineConfig } from "vite";

// gh-pages serves under /<repo>/. Local dev stays at /.
export default defineConfig({
  base: process.env.NODE_ENV === "production" ? "/mudra-viewer/" : "/",
});
