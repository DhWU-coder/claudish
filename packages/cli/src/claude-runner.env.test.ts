import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeWithProxy } from "./claude-runner.js";
import type { ClaudishConfig } from "./types.js";

const originalClaudePath = process.env.CLAUDE_PATH;
const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

function baseConfig(model: string): ClaudishConfig {
  return {
    model,
    autoApprove: true,
    dangerous: false,
    interactive: false,
    debug: false,
    logLevel: "minimal",
    quiet: true,
    jsonOutput: false,
    monitor: false,
    stdin: false,
    claudeArgs: ["ping"],
    noLogs: true,
    diagMode: "off",
  };
}

describe("runClaudeWithProxy environment", () => {
  let tmp: string;
  let envPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "claudish-runner-env-"));
    envPath = join(tmp, "env.json");
    const fakeClaude = join(tmp, "claude");
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node\nconst fs = require("fs");\nfs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({\n  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,\n  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,\n  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,\n  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,\n  settingsEnv: JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--settings") + 1], "utf8")).env,\n}, null, 2));\n`,
      "utf-8"
    );
    chmodSync(fakeClaude, 0o755);
    process.env.CLAUDE_PATH = fakeClaude;
    process.env.ANTHROPIC_BASE_URL = "https://user-global-gateway.example";
    process.env.ANTHROPIC_API_KEY = "sk-user-global-gateway-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "real-subscription-token-from-parent";
  });

  afterEach(() => {
    process.env.CLAUDE_PATH = originalClaudePath;
    process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
    process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("alternative providers do not pass ANTHROPIC_AUTH_TOKEN to Claude Code", async () => {
    const exitCode = await runClaudeWithProxy(baseConfig("cx@gpt-5.5"), "http://127.0.0.1:47777");
    const env = JSON.parse(readFileSync(envPath, "utf-8"));

    expect(exitCode).toBe(0);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:47777");
    expect(env.ANTHROPIC_MODEL).toBe("cx@gpt-5.5");
    expect(env.ANTHROPIC_API_KEY).toContain("placeholder-not-used-proxy");
    expect(env.ANTHROPIC_API_KEY).not.toBe("sk-user-global-gateway-key");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.settingsEnv.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:47777");
    expect(env.settingsEnv.ANTHROPIC_API_KEY).toContain("placeholder-not-used-proxy");
    expect(env.settingsEnv.ANTHROPIC_API_KEY).not.toBe("sk-user-global-gateway-key");
  });
});
