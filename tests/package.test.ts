// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";


const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const deps: Record<string, string> = packageJson.dependencies ?? {};
const devDeps: Record<string, string> = packageJson.devDependencies ?? {};

const BUILTINS: Record<string, true> = {
  "node:fs": true,
  "node:fs/promises": true,
  "node:path": true,
  "node:url": true,
  "node:os": true,
  "node:util": true,
  "node:crypto": true,
  "node:child_process": true,
  "node:events": true,
  "node:stream": true,
  "node:stream/promises": true,
  "node:buffer": true,
  "node:process": true,
  "node:http": true,
  "node:https": true,
  "node:net": true,
  "node:worker_threads": true,
  "node:assert": true,
  "node:zlib": true,
  "node:perf_hooks": true,
};

/** Provided by the Paseo daemon, not installed with the plugin. */
const HOST_PROVIDED: Record<string, true> = {
  "@getpaseo/plugin": true,
  "react": true,
  "react-native": true,
};

/**
 * Every production runtime dependency of the shipped code must be declared
 * under `dependencies`. A dependency that is only in `devDependencies` is
 * stripped by `npm install --production` and by plugin loaders that strip
 * devDeps, so the plugin fails to load.
 *
 * The test inspects the shipped source (the `files` array in package.json)
 * and verifies every direct `import` / `require` of a non-relative,
 * non-builtin specifier resolves to a package that is declared in
 * `dependencies`.
 */
describe("production runtime dependencies", () => {
  function collectShippedFiles(): string[] {
    const files: string[] = packageJson.files ?? [];
    const out: string[] = [];
    for (const entry of files) {
      if (entry.endsWith("/") || entry.includes("**")) {
        const dir = resolve(root, entry);
        if (!existsSync(dir)) continue; // missing dirs are tolerated (dead entries)
        walk(dir, out);
      } else {
        const f = resolve(root, entry);
        if (existsSync(f) && statSync(f).isFile() && /\.(ts|js|mjs|cjs|mts|cts)$/.test(f)) {
          out.push(f);
        }
      }
    }
    return out;
  }

  function walk(dir: string, out: string[]): void {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|js|mjs|cjs|mts|cts)$/.test(e.name)) out.push(p);
    }
  }

  function extractSpecifiers(source: string): string[] {
    const specs = new Set<string>();
    const visit = (node: ts.Node): void => {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
        specifier = node.moduleSpecifier;
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
        specifier = node.moduleSpecifier;
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        specifier = node.moduleReference.expression;
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
        specifier = node.arguments[0];
      }
      if (specifier && ts.isStringLiteral(specifier)) specs.add(specifier.text);
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest));
    return [...specs];
  }

  function packageOf(spec: string): string | null {
    if (spec.startsWith("node:")) return null;
    if (spec.startsWith(".")) return null;
    if (BUILTINS[spec]) return null;
    if (spec.startsWith("@")) {
      const parts = spec.split("/");
      return parts.slice(0, 2).join("/");
    }
    return spec.split("/")[0];
  }

  it("excludes type-only declarations and retains runtime imports", () => {
    expect(extractSpecifiers(`
      import type { Client } from "type-only-client";
      export /* comment */ type { Result } from "type-only-result";
      import { create, type Options } from "runtime-client";
      import "side-effect";
      require("commonjs");
    `)).toEqual(["runtime-client", "side-effect", "commonjs"]);
  });

  it("declares every direct production runtime dependency under `dependencies`", () => {
    const shipped = collectShippedFiles();
    expect(shipped.length, "expected at least one shipped source file").toBeGreaterThan(0);

    const declared: Record<string, string> = { ...deps, ...devDeps };
    const missing: string[] = [];
    const inDevOnly: string[] = [];

    for (const file of shipped) {
      const rel = file.replace(root + "/", "./");
      const source = readFileSync(file, "utf8");
      for (const spec of extractSpecifiers(source)) {
        const pkg = packageOf(spec);
        if (!pkg) continue;
        if (HOST_PROVIDED[pkg]) continue;
        if (pkg in deps) continue;
        if (declared[pkg]) {
          inDevOnly.push(`${pkg}  (imported by ${rel}) — declared in devDependencies only`);
        } else {
          missing.push(`${pkg}  (imported by ${rel}) — not declared anywhere`);
        }
      }
    }

    const problems = [...missing, ...inDevOnly].sort();

    expect(
      problems,
      "These specifiers are imported by shipped code but are not production dependencies:\n" +
        (problems.length ? problems.join("\n") : "") +
        "\nMove each into `dependencies` in package.json."
    ).toEqual([]);
  });

  it("declares `zod` as a production dependency (it is imported at runtime by server/contracts.ts)", () => {
    // The specific finding from the review: zod is imported at the top of
    // server/contracts.ts and therefore needed at runtime when the plugin is
    // loaded in an environment where devDependencies are stripped.
    expect(
      "zod" in deps,
      `zod must be in \`dependencies\`, not only in \`devDependencies\`. Current: dependencies=${JSON.stringify(Object.keys(deps))} devDependencies=${JSON.stringify(Object.keys(devDeps))}`
    ).toBe(true);
  });

  it("sanity-checks that server/contracts.ts imports zod at runtime", () => {
    // Guard against the test itself becoming a tautology: the test only makes
    // sense if server/contracts.ts actually imports zod at the top level.
    const contractsPath = resolve(root, "server", "contracts.ts");
    const source = readFileSync(contractsPath, "utf8");
    const specs = extractSpecifiers(source);
    const zodSpecs = specs.filter((s) => packageOf(s) === "zod");
    expect(zodSpecs.length, "server/contracts.ts must import zod").toBeGreaterThan(0);
  });
});

describe("Paseo host compatibility", () => {
  it("ships the manifest icon and a safe self-contained SVG source", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "paseo-plugin.json"), "utf8"));
    // Paseo's manifest accepts PNG; retain the editable vector beside it.
    expect(manifest.icon).toBe("assets/icon.png");
    const sourcePath = "assets/icon.svg";
    for (const file of [manifest.icon, sourcePath]) {
      expect(existsSync(resolve(root, file)), `${file} must exist`).toBe(true);
    }
    const svg = readFileSync(resolve(root, sourcePath), "utf8");
    expect(svg).not.toMatch(/<\?|<!|&/);
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(document.querySelector("parsererror")).toBeNull();
    expect(document.documentElement.localName).toBe("svg");
    expect(document.documentElement.namespaceURI).toBe("http://www.w3.org/2000/svg");
    for (const element of Array.from(document.querySelectorAll("*"))) {
      expect(["svg", "rect", "path"]).toContain(element.localName);
      for (const attribute of Array.from(element.attributes)) {
        expect(["xmlns", "viewBox", "width", "height", "x", "y", "rx", "d", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"]).toContain(attribute.name);
        if (attribute.name !== "xmlns") expect(attribute.value).not.toMatch(/url\s*\(|:|\/\//i);
      }
    }
    const png = readFileSync(resolve(root, manifest.icon));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }));
    const shipped = packed.files.map((file: { path: string }) => file.path);
    expect(shipped).toEqual(expect.arrayContaining(["paseo-plugin.json", manifest.icon, sourcePath]));
  });

  it("keeps every server-entry relative dependency under server/ or shared/", () => {
    const entry = resolve(root, "index.server.ts");
    const invalid: string[] = [];
    const visited = new Set<string>();
    const visit = (file: string): void => {
      if (visited.has(file)) return;
      visited.add(file);
      const source = readFileSync(file, "utf8");
      const relativeImports = [...source.matchAll(/\b(?:import|export)\s+[\s\S]*?\bfrom\s+["'](\.[^"']+)["']/g)]
        .map((match) => match[1]);
      for (const specifier of relativeImports) {
        const dependency = resolve(dirname(file), `${specifier}.ts`);
        const relative = dependency.slice(root.length + 1);
        if (!(relative.startsWith("server/") || relative.startsWith("shared/"))) invalid.push(relative);
        if (existsSync(dependency)) visit(dependency);
      }
    };
    visit(entry);
    expect(invalid).toEqual([]);
  });
});
