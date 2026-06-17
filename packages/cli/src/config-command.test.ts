import { describe, expect, test } from "bun:test";
import { formatCustomProviderLine } from "./config-command.js";

describe("config command", () => {
  test("formatCustomProviderLine includes multi-model provider details", () => {
    // The CLI config view should make it clear that one provider can offer
    // multiple models instead of implying a one-to-one provider/model mapping.
    const line = formatCustomProviderLine({
      id: "corp-openai",
      kind: "simple",
      displayName: "corp-openai",
      format: "openai",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "secret",
      defaultModel: "gpt-4o",
      models: ["gpt-4o", "gpt-4.1"],
    });

    expect(line).toContain("corp-openai");
    expect(line).toContain("openai");
    expect(line).toContain("2 models");
    expect(line).toContain("default gpt-4o");
    expect(line).toContain("gpt-4o, gpt-4.1");
  });
});
