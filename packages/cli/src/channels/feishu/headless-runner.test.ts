import { describe, expect, test } from "bun:test";
import { buildFeishuHeadlessCommand, extractHeadlessText } from "./headless-runner.js";

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
      "--json",
      "-y",
      "--",
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
});
