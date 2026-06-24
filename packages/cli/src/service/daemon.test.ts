import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServiceState } from "./state.js";
import { startServiceDaemon } from "./daemon.js";

let home: string;
const originalHome = process.env.CLAUDISH_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudish-service-daemon-"));
  process.env.CLAUDISH_HOME = home;
});

afterEach(() => {
  process.env.CLAUDISH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("service daemon", () => {
  test("starts web server, writes state, and stops channels", async () => {
    const webCalls: Array<{ port: number; terminalWorkingDirectory: string }> = [];
    const channelEvents: string[] = [];

    const daemon = await startServiceDaemon({
      cwd: "/tmp/project",
      port: 17888,
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      startWebServer: (options) => {
        webCalls.push({
          port: options.port ?? 0,
          terminalWorkingDirectory: options.terminalWorkingDirectory ?? "",
        });
        return {
          port: options.port ?? 0,
          stop() {
            channelEvents.push("web-stop");
          },
        };
      },
      createChannelManager: () => ({
        async start() {
          channelEvents.push("channel-start");
        },
        async stop() {
          channelEvents.push("channel-stop");
        },
        getStatus() {
          return { channels: [{ id: "feishu", status: "not_configured", activeSessions: 0 }] };
        },
      }),
    });

    expect(webCalls).toEqual([{ port: 17888, terminalWorkingDirectory: "/tmp/project" }]);
    expect(readServiceState()).toMatchObject({
      pid: process.pid,
      port: 17888,
      webUrl: "http://127.0.0.1:17888/",
      cwd: "/tmp/project",
      channels: {
        feishu: { status: "not_configured", activeSessions: 0 },
      },
    });

    await daemon.stop();

    expect(channelEvents).toEqual(["channel-start", "channel-stop", "web-stop"]);
    expect(readServiceState()).toBeNull();
  });

  test("default daemon exposes Feishu channel status to Web server", async () => {
    let channels: unknown;

    const daemon = await startServiceDaemon({
      cwd: "/tmp/project",
      port: 17888,
      startWebServer: (options) => {
        channels = options.channelStatusProvider?.();
        return {
          port: options.port ?? 0,
          stop() {},
        };
      },
    });

    await daemon.stop();

    expect(channels).toEqual({
      channels: [
        {
          id: "feishu",
          status: "not_configured",
          activeSessions: 0,
          model: "cx@gpt-5.5",
          cwd: "/tmp/project",
          recentMessages: [],
        },
      ],
    });
  });

  test("default daemon uses and creates ~/.claudish/workspace when cwd is omitted", async () => {
    let terminalWorkingDirectory = "";
    let channelCwd = "";

    const daemon = await startServiceDaemon({
      port: 17888,
      startWebServer: (options) => {
        terminalWorkingDirectory = options.terminalWorkingDirectory ?? "";
        return {
          port: options.port ?? 0,
          stop() {},
        };
      },
      createChannelManager: (options) => {
        channelCwd = options.cwd;
        return {
          async start() {},
          async stop() {},
          getStatus() {
            return { channels: [{ id: "feishu", status: "not_configured", activeSessions: 0 }] };
          },
        };
      },
    });

    await daemon.stop();

    expect(terminalWorkingDirectory).toBe(join(home, "workspace"));
    expect(channelCwd).toBe(join(home, "workspace"));
    expect(existsSync(join(home, "workspace"))).toBe(true);
  });
});
