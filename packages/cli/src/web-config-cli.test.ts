import { describe, expect, test } from "bun:test";
import { startConfigWebCli } from "./web-config-cli.js";
import type { ServiceState } from "./service/state.js";

const runningState: ServiceState = {
  pid: process.pid,
  startedAt: "2026-06-23T00:00:00.000Z",
  host: "127.0.0.1",
  port: 17888,
  webUrl: "http://127.0.0.1:17888/",
  logPath: "/tmp/claudish.log",
  cwd: "/tmp/project",
  channels: {},
};

describe("web config CLI launcher", () => {
  test("opens the running service Web UI by default", () => {
    let openedUrl = "";
    const result = startConfigWebCli({
      serviceState: runningState,
      browserOpener: (url) => {
        openedUrl = url;
      },
    });

    expect(result).toBeNull();
    expect(openedUrl).toBe("http://127.0.0.1:17888/");
  });

  test("asks the user to start service when no service is running", () => {
    const messages: string[] = [];
    const result = startConfigWebCli({
      serviceState: null,
      messageWriter: (message) => messages.push(message),
    });

    expect(result).toBeNull();
    expect(messages.join("\n")).toContain("claudish start");
  });
});
