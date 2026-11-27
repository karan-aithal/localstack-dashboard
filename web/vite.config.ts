import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "localhost",
    port: 5180,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8080" },
  },
});
