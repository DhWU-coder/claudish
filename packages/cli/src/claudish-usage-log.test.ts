import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeClaudishUsageFromProviderUsage } from "./claudish-usage-log.js";

let tempRoot: string | undefined;

beforeEach(() => {
  // Each test writes a real JSONL file into an isolated project root.
  tempRoot = mkdtempSync(join(tmpdir(), "claudish-usage-"));
});

afterEach(() => {
  // Remove generated usage logs so tests never leak local accounting data.
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("claudish usage project log", () => {
  test("writes .claudish-usage JSONL with mapped OpenAI-compatible usage", () => {
    const cwd = join(tempRoot!, "work");

    const wrote = writeClaudishUsageFromProviderUsage({
      projectRoot: tempRoot!,
      cwd,
      sessionId: "session-test",
      requestId: "req_123",
      model: "gpt-4o",
      provider: "aigateway",
      apiSurface: "openai-chat-completions",
      timestamp: "2026-06-17T00:00:00.000Z",
      rawUsage: {
        prompt_tokens: 30,
        completion_tokens: 12,
        total_tokens: 42,
        prompt_tokens_details: { cached_tokens: 9 },
        completion_tokens_details: { reasoning_tokens: 4 },
      },
    });

    const usagePath = join(tempRoot!, ".claudish-usage", "usage.jsonl");
    const event = JSON.parse(readFileSync(usagePath, "utf-8").trim());

    expect(wrote).toBe(true);
    expect(event).toEqual({
      schema_version: "claudish-usage.project-log.v1",
      timestamp: "2026-06-17T00:00:00.000Z",
      source: "claudish",
      channel: "Claudish",
      provider: "aigateway",
      api_surface: "openai-chat-completions",
      project_root: tempRoot,
      cwd,
      session_id: "session-test",
      request_id: "req_123",
      model: "gpt-4o",
      usage: {
        total: 42,
        input: 30,
        cached: 9,
        output: 12,
        reasoning: 4,
      },
    });
  });

  test("does not write a log when provider usage is missing real counters", () => {
    const wrote = writeClaudishUsageFromProviderUsage({
      projectRoot: tempRoot!,
      model: "gpt-4o",
      provider: "aigateway",
      apiSurface: "openai-chat-completions",
      rawUsage: {},
    });

    // Missing provider counters are skipped instead of being estimated.
    expect(wrote).toBe(false);
    expect(existsSync(join(tempRoot!, ".claudish-usage", "usage.jsonl"))).toBe(false);
  });
});
