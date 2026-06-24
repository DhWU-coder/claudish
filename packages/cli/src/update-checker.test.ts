import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdates } from "./update-checker.js";

const originalHome = process.env.HOME;
const originalFetch = globalThis.fetch;
const originalStderrWrite = process.stderr.write;
const originalConsoleError = console.error;

let tempHome: string | undefined;
let stderrOutput = "";

describe("私有仓库更新检查", () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "claudish-private-update-"));
    process.env.HOME = tempHome;
    stderrOutput = "";
    (process.stderr as any).write = (chunk: string) => {
      stderrOutput += chunk;
      return true;
    };
    console.error = (...args: unknown[]) => {
      stderrOutput += `${args.join(" ")}\n`;
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalStderrWrite;
    console.error = originalConsoleError;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  test("默认不访问 npm registry，也不显示公网版本提示", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("不应该访问公网更新源");
    }) as typeof fetch;

    await checkForUpdates("2.1");

    expect(fetchCalls).toBe(0);
    expect(stderrOutput).toBe("");
  });
});
