import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface PackageManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "../package.json"), "utf-8")
) as PackageManifest;

const opentuiPlatformPackages = [
  "@opentui/core-darwin-arm64",
  "@opentui/core-darwin-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-x64",
  "@opentui/core-win32-arm64",
  "@opentui/core-win32-x64",
] as const;

describe("CLI 包清单", () => {
  test("OpenTUI 核心包与 React 适配包使用相同的精确版本", () => {
    const coreVersion = manifest.dependencies?.["@opentui/core"];
    const reactVersion = manifest.dependencies?.["@opentui/react"];

    expect(coreVersion).toBeDefined();
    expect(coreVersion).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
    expect(reactVersion).toBe(coreVersion);
  });

  test("OpenTUI 平台原生包是与核心包同版本的直接可选依赖", () => {
    const coreVersion = manifest.dependencies?.["@opentui/core"];

    expect(coreVersion).toBeDefined();
    for (const packageName of opentuiPlatformPackages) {
      expect(manifest.optionalDependencies?.[packageName]).toBe(coreVersion);
    }
  });
});
