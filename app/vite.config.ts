import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const BUILD = "v3.4 " + new Date().toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: { host: true, port: 5173 },
});
