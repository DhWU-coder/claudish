import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveJsonSecure } from "./profile-config.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("secure JSON persistence", () => {
  test("creates parent directories with owner-only permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-config-"));
    tempDirs.push(dir);
    const nested = join(dir, "nested", "config.json");

    saveJsonSecure(nested, { apiKeys: { OPENROUTER_API_KEY: "secret" } });

    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
  });

  test("writes sensitive JSON files with owner-only permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-config-"));
    tempDirs.push(dir);
    const file = join(dir, "config.json");

    saveJsonSecure(file, { apiKeys: { OPENROUTER_API_KEY: "secret" } });

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
