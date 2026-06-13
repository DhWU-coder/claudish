import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./profile-config.js";
import { saveProviderConfig } from "./provider-setup-command.js";

const originalClaudishHome = process.env.CLAUDISH_HOME;
let tempHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "claudish-provider-setup-"));
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

describe("saveProviderConfig", () => {
  test("writes a simple custom endpoint with default model", () => {
    saveProviderConfig({
      providerId: "corp-openai",
      compatibility: "openai",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "${CORP_LLM_KEY}",
      modelId: "gpt-4o",
    });

    const config = loadConfig();
    expect(config.customEndpoints?.["corp-openai"]).toEqual({
      kind: "simple",
      url: "https://llm.example.com/v1",
      format: "openai",
      apiKey: "${CORP_LLM_KEY}",
      defaultModel: "gpt-4o",
    });
  });
});
