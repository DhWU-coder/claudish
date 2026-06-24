import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFeishuHeadlessCommand,
  extractHeadlessText,
  parseHeadlessStreamLine,
  runFeishuHeadless,
} from "./headless-runner.js";

describe("Feishu headless runner", () => {
  test("builds a claudish print command with Claude Code session id", () => {
    const command = buildFeishuHeadlessCommand({
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
      prompt: "[Alice] hello\n",
      sessionId: "11111111-1111-4111-8111-111111111111",
      resume: false,
      nativeResume: true,
      env: { PATH: "/bin" },
    });

    expect(command.command).toBe("claudish");
    expect(command.cwd).toBe("/tmp/project");
    expect(command.stdin).toBe("[Alice] hello\n");
    expect(command.args).toEqual([
      "--model",
      "cx@gpt-5.5",
      "--stdin",
      "--quiet",
      "-y",
      "--",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(command.env.CLAUDISH_ASSUME_AUTO_APPROVE_CONFIRMED).toBe("1");
  });

  test("builds a resume command after the native session exists", () => {
    const command = buildFeishuHeadlessCommand({
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
      prompt: "continue\n",
      sessionId: "11111111-1111-4111-8111-111111111111",
      resume: true,
      nativeResume: true,
      env: {},
    });

    expect(command.args.slice(-2)).toEqual(["--resume", "11111111-1111-4111-8111-111111111111"]);
  });

  test("extracts text from Claude Code json output", () => {
    expect(extractHeadlessText(JSON.stringify({ result: "answer" }))).toBe("answer");
    expect(extractHeadlessText("plain answer\n")).toBe("plain answer");
  });

  test("extracts final text from Claude Code stream-json output", () => {
    const output = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "我先看文件。" },
            { type: "tool_use", name: "Read", input: { file_path: "src/index.ts" } },
          ],
        },
      }),
      JSON.stringify({ type: "result", result: "最终答案" }),
    ].join("\n");

    expect(extractHeadlessText(output)).toBe("最终答案");
  });

  test("parses assistant and tool progress from stream-json lines", () => {
    const parsed = parseHeadlessStreamLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "我先检查项目。" },
            { type: "tool_use", name: "Bash", input: { command: "bun test" } },
          ],
        },
      })
    );

    expect(parsed.events).toEqual([
      { type: "assistant_text", text: "我先检查项目。" },
      { type: "tool_start", name: "Bash", input: { command: "bun test" } },
    ]);
    expect(parsed.resultText).toBeUndefined();
  });

  test("runFeishuHeadless emits progress while keeping final result separate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-feishu-headless-progress-"));
    const script = join(dir, "fake-claudish.sh");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "printf '%s\\n' '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Read\",\"input\":{\"file_path\":\"src/index.ts\"}}]}}'",
        "printf '%s\\n' '{\"type\":\"result\",\"result\":\"最终答案\"}'",
      ].join("\n"),
      "utf-8"
    );
    chmodSync(script, 0o755);
    const events: unknown[] = [];

    try {
      const result = await runFeishuHeadless({
        model: "cx@gpt-5.5",
        cwd: dir,
        prompt: "hello",
        sessionId: "11111111-1111-4111-8111-111111111111",
        resume: false,
        nativeResume: true,
        env: { ...process.env, CLAUDISH_COMMAND: script },
        onProgress: (event) => events.push(event),
      });

      expect(events).toEqual([
        { type: "tool_start", name: "Read", input: { file_path: "src/index.ts" } },
      ]);
      expect(result.text).toBe("最终答案");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
