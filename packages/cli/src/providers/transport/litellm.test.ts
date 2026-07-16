import { describe, expect, it } from "bun:test";
import { LiteLLMProviderTransport } from "./litellm.js";

describe("LiteLLMProviderTransport.getHeaders()", () => {
  it("omits the Authorization header when the API key is empty", async () => {
    const transport = new LiteLLMProviderTransport("http://127.0.0.1:4000", "", "model");
    const headers = await transport.getHeaders();

    expect(headers.Authorization).toBeUndefined();
  });
});
