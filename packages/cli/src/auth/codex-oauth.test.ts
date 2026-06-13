import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexOAuth } from "./codex-oauth.js";

const originalHome = process.env.HOME;
const originalClaudishHome = process.env.CLAUDISH_HOME;
const originalFetch = globalThis.fetch;

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function jwt(payload: object): string {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.sig`;
}

function resetSingleton(): void {
  (CodexOAuth as unknown as { instance: CodexOAuth | null }).instance = null;
}

describe("CodexOAuth", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "claudish-codex-oauth-"));
    process.env.HOME = home;
    process.env.CLAUDISH_HOME = join(home, ".claudish");
    resetSingleton();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.CLAUDISH_HOME = originalClaudishHome;
    globalThis.fetch = originalFetch;
    resetSingleton();
    rmSync(home, { recursive: true, force: true });
  });

  test("refreshes with form encoding and saves account id from access token auth claim", async () => {
    const credPath = join(process.env.CLAUDISH_HOME!, "codex-oauth.json");
    mkdirSync(process.env.CLAUDISH_HOME!, { recursive: true });
    const oldAccess = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    const newAccess = jwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_reference" },
    });

    writeFileSync(
      credPath,
      JSON.stringify({
        access_token: oldAccess,
        refresh_token: "refresh-reference",
        expires_at: Date.now() - 1_000,
      }),
      { mode: 0o600 }
    );

    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          access_token: newAccess,
          refresh_token: "refresh-updated",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const token = await CodexOAuth.getInstance().getAccessToken();

    expect(token).toBe(newAccess);
    expect(capturedInit?.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(String(capturedInit?.body)).toContain("grant_type=refresh_token");
    expect(String(capturedInit?.body)).toContain("refresh_token=refresh-reference");
    expect(String(capturedInit?.body)).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");

    const saved = JSON.parse(readFileSync(credPath, "utf-8"));
    expect(saved.account_id).toBe("acct_reference");
    expect(saved.refresh_token).toBe("refresh-updated");
  });
});
