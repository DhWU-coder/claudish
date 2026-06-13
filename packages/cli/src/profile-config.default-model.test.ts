import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, setDefaultModel } from "./profile-config.js";

const originalClaudishHome = process.env.CLAUDISH_HOME;
let tempHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "claudish-config-default-model-"));
  process.env.CLAUDISH_HOME = join(tempHome, ".claudish");
});

afterEach(() => {
  if (originalClaudishHome === undefined) {
    process.env.CLAUDISH_HOME = undefined;
  } else {
    process.env.CLAUDISH_HOME = originalClaudishHome;
  }
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  }
});

describe("default model config", () => {
  test("loadConfig preserves defaultModel from config.json", () => {
    saveConfig({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      defaultModel: "cx@gpt-5.5",
    });

    expect(loadConfig().defaultModel).toBe("cx@gpt-5.5");
  });

  test("setDefaultModel writes defaultModel to config.json", () => {
    setDefaultModel("cx@gpt-5.5");

    const raw = readFileSync(join(process.env.CLAUDISH_HOME!, "config.json"), "utf-8");
    expect(JSON.parse(raw).defaultModel).toBe("cx@gpt-5.5");
  });
});
