/**
 * Real chat bridge for the local Web configuration UI.
 *
 * The Web UI should not reimplement every provider transport. Instead it sends
 * Anthropic-style messages through the existing claudish proxy pipeline, which
 * already knows OAuth, custom endpoints, fallback routing, and stream parsing.
 */

import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

export interface WebChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface WebChatRequest {
  provider?: string;
  model?: string;
  messages: WebChatMessage[];
}

export interface WebChatService {
  streamChat(input: WebChatRequest): Promise<Response>;
}

export interface ProxyBackedChatServiceOptions {
  proxyFactory?: () => Promise<ProxyServer>;
  fetchImpl?: typeof fetch;
  maxTokens?: number;
}

/**
 * Resolve the model string that should enter the existing claudish router.
 */
export function resolveChatModelSpec(input: Pick<WebChatRequest, "provider" | "model">): string {
  const model = input.model?.trim() ?? "";
  const provider = input.provider?.trim() ?? "";

  if (!model) {
    throw new Error("Choose a model before sending a message.");
  }

  // Explicit specs such as cx@gpt-5.5 already encode the provider.
  if (model.includes("@")) {
    return model;
  }

  if (!provider) {
    return model;
  }

  return `${provider}@${model}`;
}

/**
 * Convert browser chat input into the request shape consumed by /v1/messages.
 */
export function buildClaudeChatPayload(
  input: WebChatRequest,
  maxTokens = 1024
): Record<string, unknown> {
  const messages = normalizeChatMessages(input.messages);

  if (messages.length === 0) {
    throw new Error("Send at least one message.");
  }

  return {
    model: resolveChatModelSpec(input),
    max_tokens: maxTokens,
    stream: true,
    messages,
  };
}

/**
 * Create a chat service that lazily starts the existing claudish proxy server.
 */
export function createProxyBackedChatService(
  options: ProxyBackedChatServiceOptions = {}
): WebChatService {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxTokens = options.maxTokens ?? 1024;
  let proxyPromise: Promise<ProxyServer> | undefined;

  /**
   * Start the internal proxy only when the first chat request arrives.
   */
  async function getProxy(): Promise<ProxyServer> {
    if (!proxyPromise) {
      proxyPromise = options.proxyFactory ? options.proxyFactory() : createDefaultProxy();
    }
    return proxyPromise;
  }

  return {
    async streamChat(input: WebChatRequest): Promise<Response> {
      const proxy = await getProxy();
      const payload = buildClaudeChatPayload(input, maxTokens);

      return fetchImpl(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
  };
}

/**
 * Start the normal claudish proxy in quiet localhost mode for Web UI chat.
 */
async function createDefaultProxy(): Promise<ProxyServer> {
  return createProxyServer(
    0,
    process.env.OPENROUTER_API_KEY,
    undefined,
    false,
    process.env.ANTHROPIC_API_KEY,
    undefined,
    {
      quiet: true,
      isInteractive: true,
    }
  );
}

/**
 * Keep only valid text chat messages before handing them to the proxy.
 */
function normalizeChatMessages(messages: WebChatMessage[]): WebChatMessage[] {
  return messages
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .filter((message) => {
      const validRole = message.role === "user" || message.role === "assistant";
      return validRole && message.content.length > 0;
    });
}
