import { defineConfig } from "vite";
import { URL, fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: [
    { find: "@getpaseo/plugin/client/ui", replacement: fileURLToPath(new URL("./host-ui.tsx", import.meta.url)) },
    { find: "@getpaseo/plugin/client", replacement: fileURLToPath(new URL("./host-client.tsx", import.meta.url)) },
    { find: /^react-native$/, replacement: fileURLToPath(new URL("./host-ui.tsx", import.meta.url)) },
  ] },
  server: { host: "127.0.0.1", port: 4178, strictPort: true },
});
