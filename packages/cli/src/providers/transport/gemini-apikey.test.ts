import { describe, expect, it } from "bun:test";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { GeminiProviderTransport } from "./gemini-apikey.js";

describe("GeminiProviderTransport.getHeaders()", () => {
  it("omits the API key header when the API key is empty", async () => {
    const provider: RemoteProvider = {
      name: "local-gemini",
      baseUrl: "http://127.0.0.1:8000",
      apiPath: "/v1beta/models/{model}:streamGenerateContent?alt=sse",
      apiKeyEnvVar: "",
      prefixes: [],
    };

    const transport = new GeminiProviderTransport(provider, "gemini-model", "");
    const headers = await transport.getHeaders();

    expect(headers["x-goog-api-key"]).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
  });
});
