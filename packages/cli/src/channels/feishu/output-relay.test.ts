import { describe, expect, test } from "bun:test";
import { FeishuOutputRelay, stripAnsi } from "./output-relay.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("FeishuOutputRelay", () => {
  test("stripAnsi removes terminal escape codes", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
  });

  test("buffers chunks until quiet period", async () => {
    const sent: string[] = [];
    const relay = new FeishuOutputRelay({
      quietMs: 10,
      maxChunkLength: 100,
      sendText: async (text) => {
        sent.push(text);
      },
    });

    relay.append("hello ");
    relay.append("world");
    expect(sent).toEqual([]);

    await delay(25);
    expect(sent).toEqual(["hello world"]);
  });

  test("chunks long output", async () => {
    const sent: string[] = [];
    const relay = new FeishuOutputRelay({
      quietMs: 1,
      maxChunkLength: 3,
      sendText: async (text) => {
        sent.push(text);
      },
    });

    relay.append("abcdef");
    await delay(10);

    expect(sent).toEqual(["abc", "def"]);
  });
});
