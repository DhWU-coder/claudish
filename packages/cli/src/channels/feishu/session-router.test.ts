import { describe, expect, test } from "bun:test";
import { FeishuSessionRouter } from "./session-router.js";
import type {
  CreatePythonTerminalSessionOptions,
  WebTerminalSession,
} from "../../web-terminal-service.js";

function createFakeSessionFactory(writes: string[]) {
  const sessions: WebTerminalSession[] = [];
  const options: CreatePythonTerminalSessionOptions[] = [];

  return {
    sessions,
    options,
    createSession(input: CreatePythonTerminalSessionOptions): WebTerminalSession {
      options.push(input);
      const session: WebTerminalSession = {
        pid: sessions.length + 1,
        write(data: string) {
          writes.push(data);
        },
        resize() {},
        kill() {},
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
});
