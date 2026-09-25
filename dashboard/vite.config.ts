import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Run the server with PUBLIC_URL=http://localhost:5173 in dev, so the CSRF
    // Origin check and invite links match the Vite origin.
    proxy: { "/api": "http://localhost:3000" },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Node 25+ ships its own global localStorage, which is unusable without
    // --localstorage-file. Vitest won't overwrite a global that already exists,
    // so jsdom's localStorage would never be installed. Turn Node's off.
    poolOptions: { forks: { execArgv: ["--no-experimental-webstorage"] } },
  },
});
