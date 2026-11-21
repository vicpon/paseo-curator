import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "paseo-plugin.json"), "utf8"));
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

describe("public listing", () => {
  it("references real, nonempty PNG screenshots shipped in the package", () => {
    // Publishing accepts string paths, not caption/src objects or empty slots.
    expect(manifest.media.length).toBeGreaterThan(0);
    const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }));
    const shipped = pack.files.map((file: { path: string }) => file.path);
    expect(shipped).toEqual(expect.arrayContaining(["docs/listing.md", "docs/screenshots/README.md"]));
    for (const path of manifest.media) {
      expect(path).toMatch(/^assets\/[a-z0-9-]+\.png$/);
      expect(shipped).toContain(path);
      const png = readFileSync(resolve(root, path));
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(png.subarray(12, 16).toString()).toBe("IHDR");
      const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
      expect(width).toBeGreaterThanOrEqual(600);
      expect(height).toBeGreaterThanOrEqual(200);
      expect(width).toBeLessThanOrEqual(4096);
      expect(height).toBeLessThanOrEqual(4096);
      // Native captures are 8-bit RGB. Decode all image data, not just the header.
      expect([png[24], png[25], png[28]]).toEqual([8, 2, 0]);
      const chunks: Buffer[] = [];
      for (let offset = 8; offset < png.length;) {
        const length = png.readUInt32BE(offset);
        const type = png.subarray(offset + 4, offset + 8).toString();
        expect(offset + length + 12).toBeLessThanOrEqual(png.length);
        if (type === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
        offset += length + 12;
      }
      const pixels = inflateSync(Buffer.concat(chunks));
      expect(pixels.length).toBe((width * 3 + 1) * height);
      expect(new Set(pixels).size, "reject blank/empty image placeholders").toBeGreaterThan(32);
    }
  });

  it("uses matching outcome descriptions and accurate runtime requirements", () => {
    expect(pkg.description).toBe(manifest.description);
    expect(pkg.description).toMatch(/reusable skills/i);
    expect(pkg.engines.node).toBe(">=22.13.0");
    expect(manifest.requirements.paseo).toBe(">=0.16.0-beta.2");
  });

  it("keeps the install decision contract in the overview and README", () => {
    for (const file of ["OVERVIEW.md", "README.md"]) {
      const text = readFileSync(resolve(root, file), "utf8");
      for (const phrase of ["10 unique tool calls", "completed turn", "existing skill", "nothing_to_save",
        "Self-improvement review", "Review provider", "Review model", "None", "22.13.0", "0.16.0-beta.2",
        "credentials", "cost", "secrets", "captured skill-file text", "120,000", "normal tool permissions", "submit_review", "same running reviewer", "no freeform JSON fallback",
        "writes", "~/.agents/skills/", "curator.sqlite", ".paseo-curator/", "created_by: paseo-curator"])
        expect(text, `${file} must explain ${phrase}`).toContain(phrase);
      expect(text).toMatch(/only to (?:the )?plugin.applied/i);
      expect(text).toMatch(/UTF-8/);
    }
    const overview = readFileSync(resolve(root, "OVERVIEW.md"), "utf8");
    expect(overview).not.toMatch(/paseo plugin add|npm (?:install|i)\b|^## (?:Install|Changelog|License|Contributing)/im);
    const readme = readFileSync(resolve(root, "README.md"), "utf8");
    for (const path of manifest.media) expect(readme).toContain(`](${path})`);
  });
});
