import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { OpenAICodexTransport } from "./openai-codex.js";

const originalHome = process.env.HOME;
const originalClaudishHome = process.env.CLAUDISH_HOME;

const provider: RemoteProvider = {
  name: "openai-codex",
  baseUrl: "https://api.openai.com",
  apiPath: "/v1/responses",
  apiKeyEnvVar: "OPENAI_CODEX_API_KEY",
  prefixes: ["cx@"],
};

describe("OpenAICodexTransport OAuth mode", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "claudish-codex-transport-"));
    process.env.HOME = home;
    process.env.CLAUDISH_HOME = join(home, ".claudish");
    mkdirSync(process.env.CLAUDISH_HOME, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.CLAUDISH_HOME = originalClaudishHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("uses the ChatGPT Codex endpoint and OpenClaw attribution headers", async () => {
    writeFileSync(
      join(process.env.CLAUDISH_HOME!, "codex-oauth.json"),
      JSON.stringify({
        access_token: "access-reference",
        refresh_token: "refresh-reference",
        expires_at: Date.now() + 60 * 60 * 1000,
        account_id: "acct_reference",
      }),
      { mode: 0o600 }
    );

    const transport = new OpenAICodexTransport(provider, "gpt-5.5", "");

    expect(transport.getEndpoint()).toBe("https://chatgpt.com/backend-api/codex/responses");

    const headers = await transport.getHeaders();
    expect(headers).toMatchObject({
      Authorization: "Bearer access-reference",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      originator: "openclaw",
      "User-Agent": expect.stringMatching(/^openclaw\//),
      version: expect.any(String),
    });
    expect(headers["OpenAI-Beta"]).toBeUndefined();
  });
});
