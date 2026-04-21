import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Local dev proxy — points to the backend running locally.
    // In production (Netlify) the _redirects file handles this instead.
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
