import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCodexUsageFromOpenAIUsage } from "./codex-usage-log.js";

let tempRoot: string | undefined;

beforeEach(() => {
  // Each test writes a real JSONL file into an isolated project root.
  tempRoot = mkdtempSync(join(tmpdir(), "claudish-codex-usage-"));
});

afterEach(() => {
  // Remove generated usage logs so tests never leak local accounting data.
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("codex usage project log", () => {
  test("writes codex-usage JSONL with mapped OpenAI Responses usage", () => {
    const cwd = join(tempRoot!, "work");

    const wrote = writeCodexUsageFromOpenAIUsage({
      projectRoot: tempRoot!,
      cwd,
      sessionId: "session-test",
      requestId: "resp_123",
      model: "gpt-5.5",
      provider: "openai-codex",
      auth: "codex-oauth",
      apiSurface: "chatgpt-codex-responses",
      timestamp: "2026-06-17T00:00:00.000Z",
      rawUsage: {
        total_tokens: 42,
        input_tokens: 30,
        output_tokens: 12,
        input_tokens_details: { cached_tokens: 9 },
        output_tokens_details: { reasoning_tokens: 4 },
      },
    });

    const usagePath = join(tempRoot!, ".codex-usage", "usage.jsonl");
    const event = JSON.parse(readFileSync(usagePath, "utf-8").trim());

    expect(wrote).toBe(true);
    expect(event).toEqual({
      schema_version: "codex-usage.project-log.v1",
      timestamp: "2026-06-17T00:00:00.000Z",
      source: "claudish",
      channel: "Claudish",
      provider: "openai-codex",
      auth: "codex-oauth",
      api_surface: "chatgpt-codex-responses",
      project_root: tempRoot,
      cwd,
      session_id: "session-test",
      request_id: "resp_123",
      model: "gpt-5.5",
      usage: {
        total: 42,
        input: 30,
        cached: 9,
        output: 12,
        reasoning: 4,
      },
    });
  });

  test("does not write a log when the response has no real total usage", () => {
    const wrote = writeCodexUsageFromOpenAIUsage({
      projectRoot: tempRoot!,
      cwd: tempRoot!,
      sessionId: "session-test",
      model: "gpt-5.5",
      provider: "openai-codex",
      auth: "codex-oauth",
      apiSurface: "chatgpt-codex-responses",
      rawUsage: {
        input_tokens: 30,
        output_tokens: 12,
      },
    });

    // The codex-usage schema requires total tokens, so missing totals are skipped.
    expect(wrote).toBe(false);
    expect(existsSync(join(tempRoot!, ".codex-usage", "usage.jsonl"))).toBe(false);
  });
});
