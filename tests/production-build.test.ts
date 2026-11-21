import { it, expect } from "vitest";
import { cpSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileDirectoryPlugin } from "../node_modules/@getpaseo/server/dist/server/server/plugins/compiler-build.js";
import { cleanupRoot, makeTempRoot } from "./fixtures";

it("builds both real Paseo runtime entries with only declared production dependencies present", async () => {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const root = makeTempRoot("production-build");
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  try {
    for (const path of ["package.json", "paseo-plugin.json", "index.client.tsx", "index.server.ts", "client", "server", "shared", "assets"]) {
      cpSync(join(source, path), join(root, path), { recursive: true });
    }
    // Match npm --omit=dev without network-dependent installs in the unit suite.
    // The real host compiler must resolve type-only imports too when checking
    // the client/server boundary, even though TypeScript later erases them.
    for (const dependency of Object.keys(pkg.dependencies)) {
      const destination = join(root, "node_modules", dependency);
      mkdirSync(dirname(destination), { recursive: true });
      symlinkSync(join(source, "node_modules", dependency), destination, "dir");
    }
    const result = await compileDirectoryPlugin(root, "0.17.0-beta.1");
    expect(result.serverBundle?.length).toBeGreaterThan(0);
    expect(result.clientBundle?.length).toBeGreaterThan(0);
  } finally { cleanupRoot(root); }
});
