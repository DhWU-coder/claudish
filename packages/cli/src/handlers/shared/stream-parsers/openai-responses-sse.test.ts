import { describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { createResponsesStreamHandler } from "./openai-responses-sse.js";

function testContext(): Context {
  // The parser only needs c.json on error paths; this keeps the test focused.
  return {
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  } as unknown as Context;
}

function sseResponse(...events: string[]): Response {
  // Build a small OpenAI Responses SSE stream with explicit data events.
  return new Response(events.map((event) => `data: ${event}\n\n`).join(""), {
    headers: {
      "content-type": "text/event-stream",
      "x-request-id": "req_header_123",
    },
  });
}

describe("OpenAI Responses SSE parser", () => {
  test("emits raw usage for codex project logging after a completed response", async () => {
    const usageEvents: Array<{ modelName: string; requestId?: string; usage: unknown }> = [];
    const response = sseResponse(
      JSON.stringify({ type: "response.output_text.delta", delta: "hello" }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_body_123",
          usage: {
            total_tokens: 7,
            input_tokens: 5,
            output_tokens: 2,
          },
        },
      })
    );

    const parsed = createResponsesStreamHandler(testContext(), response, {
      modelName: "gpt-5.5",
      onCodexUsage: (event) => usageEvents.push(event),
    });

    await parsed.text();

    expect(usageEvents).toEqual([
      {
        modelName: "gpt-5.5",
        requestId: "resp_body_123",
        usage: {
          total_tokens: 7,
          input_tokens: 5,
          output_tokens: 2,
        },
      },
    ]);
  });
});
