import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "hono";
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

// REGRESSION: structural weakness that allowed #102 — ComposedHandler must reject
// provider-routed strings in the modelName slot so dialect selection cannot be
// confused by provider-prefix characters. Fixed in /dev:fix session
// dev-fix-20260415-000620-e95d5090.

function makeFakeTransport(): ProviderTransport {
  return {
    name: "test-provider",
    displayName: "Test",
    streamFormat: "openai-sse",
    getEndpoint: () => "http://localhost/",
    getHeaders: () => ({}),
  } as unknown as ProviderTransport;
}

function makeTestContext(): Context {
  // ComposedHandler only needs these Hono methods for this streaming test.
  return {
    req: { header: () => ({}) },
    header: () => {},
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    body: (body: BodyInit, init?: ResponseInit) => new Response(body, init),
  } as unknown as Context;
}

function completedResponsesStream(): Response {
  // The fake upstream returns real OpenAI Responses usage and no request body.
  const events = [
    { type: "response.output_text.delta", delta: "ok" },
    {
      type: "response.completed",
      response: {
        id: "resp_codex_test",
        usage: {
          total_tokens: 11,
          input_tokens: 8,
          output_tokens: 3,
        },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: {
      "content-type": "text/event-stream",
      "x-request-id": "req_codex_test",
    },
  });
}

function completedOpenAIChatStream(): Response {
  // The fake upstream returns real OpenAI-compatible chat usage for non-Codex providers.
  const events = [
    { choices: [{ delta: { content: "ok" } }] },
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 13,
        completion_tokens: 5,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    },
  ];
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    {
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "req_claudish_test",
      },
    }
  );
}

describe("ComposedHandler — modelName invariant (#102 structural fix)", () => {
  test("throws when modelName contains '@' (routed string leaked into bare slot)", () => {
    const transport = makeFakeTransport();
    expect(() => {
      // Passing a routed string in the modelName slot is structurally invalid —
      // the bare slot must never contain provider routing syntax.
      new ComposedHandler(transport, "zai@glm-4.7", "zai@glm-4.7", 8080, {});
    }).toThrow(/modelName.*must.*not.*contain/i);
  });

  test("accepts valid bare modelName with routed targetModel", () => {
    const transport = makeFakeTransport();
    expect(() => {
      new ComposedHandler(transport, "zai@glm-4.7", "glm-4.7", 8080, {});
    }).not.toThrow();
  });

  test("accepts bare modelName when targetModel is also bare (no provider prefix)", () => {
    const transport = makeFakeTransport();
    expect(() => {
      new ComposedHandler(transport, "glm-4.7", "glm-4.7", 8080, {});
    }).not.toThrow();
  });

  test("accepts vendor-prefixed modelName (slash separator is legitimate)", () => {
    const transport = makeFakeTransport();
    expect(() => {
      new ComposedHandler(transport, "openrouter@x-ai/grok-beta", "x-ai/grok-beta", 8080, {});
    }).not.toThrow();
  });
});

describe("ComposedHandler — codex usage logging", () => {
  const originalUsageRoot = process.env.CLAUDISH_CODEX_USAGE_ROOT;
  const originalClaudishUsageRoot = process.env.CLAUDISH_USAGE_ROOT;
  let tempRoot: string | undefined;

  afterEach(() => {
    // Restore the usage root so the integration test cannot affect local logs.
    if (originalUsageRoot === undefined) process.env.CLAUDISH_CODEX_USAGE_ROOT = undefined;
    else process.env.CLAUDISH_CODEX_USAGE_ROOT = originalUsageRoot;

    if (originalClaudishUsageRoot === undefined) process.env.CLAUDISH_USAGE_ROOT = undefined;
    else process.env.CLAUDISH_USAGE_ROOT = originalClaudishUsageRoot;

    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  test("writes codex-usage JSONL for completed openai-codex Responses streams", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "claudish-composed-codex-usage-"));
    process.env.CLAUDISH_CODEX_USAGE_ROOT = tempRoot;
    process.env.CLAUDISH_USAGE_ROOT = tempRoot;
    const transport = {
      name: "openai-codex",
      displayName: "OpenAI Codex",
      streamFormat: "openai-responses-sse",
      getEndpoint: () => "https://chatgpt.com/backend-api/codex/responses",
      getHeaders: async () => ({}),
      getAuthMode: () => "codex-oauth",
      overrideStreamFormat: () => "openai-responses-sse",
      enqueueRequest: async () => completedResponsesStream(),
    } as unknown as ProviderTransport;
    const handler = new ComposedHandler(transport, "cx@gpt-5.5", "gpt-5.5", 8080, {
      adapter: new CodexAPIFormat("gpt-5.5"),
    });

    const response = await handler.handle(makeTestContext(), {
      model: "cx@gpt-5.5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    await response.text();

    const usageLog = readFileSync(join(tempRoot, ".codex-usage", "usage.jsonl"), "utf-8");
    const event = JSON.parse(usageLog.trim());
    expect(event.provider).toBe("openai-codex");
    expect(event.auth).toBe("codex-oauth");
    expect(event.api_surface).toBe("chatgpt-codex-responses");
    expect(event.model).toBe("gpt-5.5");
    expect(event.usage).toEqual({
      total: 11,
      input: 8,
      cached: 0,
      output: 3,
      reasoning: 0,
    });

    const claudishUsageLog = readFileSync(
      join(tempRoot, ".claudish-usage", "usage.jsonl"),
      "utf-8"
    );
    const claudishEvent = JSON.parse(claudishUsageLog.trim());
    expect(claudishEvent.provider).toBe("openai-codex");
    expect(claudishEvent.auth).toBe("codex-oauth");
    expect(claudishEvent.api_surface).toBe("chatgpt-codex-responses");
    expect(claudishEvent.model).toBe("gpt-5.5");
  });

  test("writes non-Codex provider usage to claudish-usage without touching codex-usage", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "claudish-composed-usage-"));
    process.env.CLAUDISH_USAGE_ROOT = tempRoot;
    process.env.CLAUDISH_CODEX_USAGE_ROOT = tempRoot;
    const transport = {
      name: "aigateway",
      displayName: "AI Gateway",
      streamFormat: "openai-sse",
      getEndpoint: () => "https://aigateway.example.com/v1/chat/completions",
      getHeaders: async () => ({}),
      enqueueRequest: async () => completedOpenAIChatStream(),
    } as unknown as ProviderTransport;
    const handler = new ComposedHandler(transport, "aigateway@gpt-4o", "gpt-4o", 8080, {});

    const response = await handler.handle(makeTestContext(), {
      model: "aigateway@gpt-4o",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    await response.text();

    const usageLog = readFileSync(join(tempRoot, ".claudish-usage", "usage.jsonl"), "utf-8");
    const event = JSON.parse(usageLog.trim());
    expect(event.provider).toBe("aigateway");
    expect(event.model).toBe("gpt-4o");
    expect(event.usage).toEqual({
      total: 18,
      input: 13,
      cached: 2,
      output: 5,
      reasoning: 0,
    });
    expect(existsSync(join(tempRoot, ".codex-usage", "usage.jsonl"))).toBe(false);
  });
});
