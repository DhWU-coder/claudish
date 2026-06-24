import { describe, expect, test } from "bun:test";
import type {
  CreatePythonTerminalSessionOptions,
  WebTerminalSession,
} from "../../web-terminal-service.js";
import { FeishuSessionRouter } from "./session-router.js";

function createFakeSessionFactory(writes: string[]) {
  const sessions: WebTerminalSession[] = [];
  const options: CreatePythonTerminalSessionOptions[] = [];
  const killed: number[] = [];

  return {
    sessions,
    options,
    killed,
    createSession(input: CreatePythonTerminalSessionOptions): WebTerminalSession {
      options.push(input);
      const pid = sessions.length + 1;
      const session: WebTerminalSession = {
        pid,
        write(data: string) {
          writes.push(data);
        },
        resize() {},
        kill() {
          killed.push(pid);
        },
      };
      sessions.push(session);
      return session;
    },
  };
}

describe("FeishuSessionRouter", () => {
  test("creates one session for each direct conversation", async () => {
    const writes: string[] = [];
    const factory = createFakeSessionFactory(writes);
    const router = new FeishuSessionRouter({
      createSession: factory.createSession,
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
    });

    await router.send("dm:ou_a", "hello");
    await router.send("dm:ou_b", "hi");

    expect(factory.sessions).toHaveLength(2);
    expect(router.listSessions().map((session) => session.conversationKey)).toEqual([
      "dm:ou_a",
      "dm:ou_b",
    ]);
  });

  test("starts Feishu PTY sessions with unattended trust args", async () => {
    const writes: string[] = [];
    const factory = createFakeSessionFactory(writes);
    const router = new FeishuSessionRouter({
      createSession: factory.createSession,
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
    });

    await router.send("dm:ou_a", "hello");

    expect(factory.options[0].claudishArgs).toContain("-y");
    expect(factory.options[0].env?.CLAUDISH_ASSUME_AUTO_APPROVE_CONFIRMED).toBe("1");
  });

  test("auto-confirms Claude Code trust prompt without forwarding it", async () => {
    const writes: string[] = [];
    const outputs: string[] = [];
    const factory = createFakeSessionFactory(writes);
    const router = new FeishuSessionRouter({
      createSession: factory.createSession,
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
      onOutput: (_conversationKey, data) => {
        outputs.push(typeof data === "string" ? data : Buffer.from(data).toString("utf-8"));
      },
    });

    await router.send("dm:ou_a", "hello");
    factory.options[0].onData(
      [
        "Accessing workspace:",
        "/tmp/project",
        "Quick safety check: Is this a project you created or one you trust?",
        "1. Yes, I trust this folder",
        "2. No, exit",
        "Enter to confirm",
      ].join("\n")
    );

    expect(writes).toEqual(["hello\n", "\n"]);
    expect(outputs).toEqual([]);

    factory.options[0].onData("normal answer");

    expect(outputs).toEqual(["normal answer"]);
  });

  test("forwards normal session output", async () => {
    const writes: string[] = [];
    const outputs: string[] = [];
    const factory = createFakeSessionFactory(writes);
    const router = new FeishuSessionRouter({
      createSession: factory.createSession,
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
      onOutput: (_conversationKey, data) => {
        outputs.push(typeof data === "string" ? data : Buffer.from(data).toString("utf-8"));
      },
    });

    await router.send("dm:ou_a", "hello");
    factory.options[0].onData("normal answer");

    expect(outputs).toEqual(["normal answer"]);
  });

  test("reuses one session for a group conversation", async () => {
    const writes: string[] = [];
    const factory = createFakeSessionFactory(writes);
    const router = new FeishuSessionRouter({
      createSession: factory.createSession,
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
    });

    await router.send("group:oc_a", "alice");
    await router.send("group:oc_a", "bob");

    expect(factory.sessions).toHaveLength(1);
    expect(writes).toEqual(["alice\n", "bob\n"]);
  });

  test("serializes writes for the same conversation", async () => {
    const writes: string[] = [];
    const factory = createFakeSessionFactory(writes);
    const router = new FeishuSessionRouter({
      createSession: factory.createSession,
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
    });

    await Promise.all([router.send("group:oc_a", "first"), router.send("group:oc_a", "second")]);

    expect(writes).toEqual(["first\n", "second\n"]);
  });

  test("resetSession kills the current PTY session so the next send starts fresh", async () => {
    const writes: string[] = [];
    const factory = createFakeSessionFactory(writes);
    const router = new FeishuSessionRouter({
      createSession: factory.createSession,
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
    });

    await router.send("group:oc_a", "first");
    expect(router.resetSession("group:oc_a")).toBe(true);
    await router.send("group:oc_a", "second");

    expect(factory.killed).toEqual([1]);
    expect(factory.sessions).toHaveLength(2);
    expect(writes).toEqual(["first\n", "second\n"]);
  });

  test("stopSession kills and removes the current PTY session", async () => {
    const writes: string[] = [];
    const factory = createFakeSessionFactory(writes);
    const router = new FeishuSessionRouter({
      createSession: factory.createSession,
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
    });

    await router.send("dm:ou_a", "hello");

    expect(router.stopSession("dm:ou_a")).toBe(true);
    expect(factory.killed).toEqual([1]);
    expect(router.listSessions()).toEqual([]);
  });
});
