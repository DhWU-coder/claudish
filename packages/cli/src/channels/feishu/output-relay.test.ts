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

  test("drops terminal chrome and echoed prompt frames", async () => {
    const sent: string[] = [];
    const relay = new FeishuOutputRelay({
      quietMs: 1,
      sendText: async (text) => {
        sent.push(text);
      },
    });

    relay.suppressEcho("你是什么模型\n");
    relay.append(
      [
        "你是什么模型",
        "────────────────────────────────────────",
        "────────────────────────────────────────",
        "                              workspace •",
        "cx@gpt-5.5 • $0.000 • N/A",
        "▶▶ bypass permissions on (shift+tab to cycle)",
        "ctrl+g to edit in Vim",
      ].join("\n")
    );
    await relay.flush();

    expect(sent).toEqual([]);
  });

  test("keeps assistant text while removing terminal chrome", async () => {
    const sent: string[] = [];
    const relay = new FeishuOutputRelay({
      quietMs: 1,
      sendText: async (text) => {
        sent.push(text);
      },
    });

    relay.suppressEcho("你是什么模型\n");
    relay.append(
      [
        "你是什么模型",
        "────────────────────────────────────────",
        "我是 cx@gpt-5.5，通过 Claudish 在 Claude Code 里运行。",
        "cx@gpt-5.5 • $0.000 • N/A",
        "ctrl+g to edit in Vim",
      ].join("\n")
    );
    await relay.flush();

    expect(sent).toEqual(["我是 cx@gpt-5.5，通过 Claudish 在 Claude Code 里运行。"]);
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

  test("reports async send failures from scheduled flush", async () => {
    const errors: string[] = [];
    const relay = new FeishuOutputRelay({
      quietMs: 1,
      sendText: async () => {
        throw new Error("reply failed");
      },
      onError(error) {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    } as ConstructorParameters<typeof FeishuOutputRelay>[0]);

    relay.append("hello");
    await delay(10);

    expect(errors).toEqual(["reply failed"]);
  });
});
