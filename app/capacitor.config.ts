import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.callapicall.voice",
  appName: "callAPIcall Voice",
  webDir: "dist",
  // Permette http/ws in chiaro verso il backend (Tailscale/LAN, niente TLS).
  server: {
    androidScheme: "http",
    cleartext: true,
  },
};

export default config;
