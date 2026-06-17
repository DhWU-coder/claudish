import { describe, expect, test } from "bun:test";
import {
  buildClaudeChatPayload,
  createProxyBackedChatService,
  resolveChatModelSpec,
} from "./web-chat-service.js";

describe("web chat service", () => {
  test("resolveChatModelSpec prefixes bare models with the selected provider", () => {
    // Bare chat-page models need a provider prefix before entering claudish routing.
    expect(resolveChatModelSpec({ provider: "openai", model: "gpt-4o" })).toBe("openai@gpt-4o");
  });

  test("resolveChatModelSpec keeps explicit provider model specs intact", () => {
    // A model that already says cx@ or openrouter@ should not be double-prefixed.
    expect(resolveChatModelSpec({ provider: "openrouter", model: "cx@gpt-5.5" })).toBe(
      "cx@gpt-5.5"
    );
  });

  test("buildClaudeChatPayload maps browser chat messages to the proxy message shape", () => {
    // The proxy already accepts Anthropic-style message payloads, so the Web UI
    // only needs a thin conversion layer.
    expect(
      buildClaudeChatPayload({
        provider: "openai",
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
      })
    ).toEqual({
      model: "openai@gpt-4o",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
  });

  test("createProxyBackedChatService posts payloads to the lazy proxy server", async () => {
    // The production service starts a localhost proxy lazily; this test injects
    // a fake one so the behavior is deterministic and offline.
    let capturedUrl = "";
    let capturedBody: unknown;
    const service = createProxyBackedChatService({
      proxyFactory: async () => ({
        port: 4567,
        url: "http://127.0.0.1:4567",
        shutdown: async () => {},
      }),
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response("data: ok\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const response = await service.streamChat({
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(capturedUrl).toBe("http://127.0.0.1:4567/v1/messages");
    expect(capturedBody).toEqual({
      model: "openai@gpt-4o",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(await response.text()).toContain("ok");
  });
});
