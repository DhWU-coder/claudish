import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeishuConfig } from "./feishu/config.js";
import { ChannelManager } from "./manager.js";
import type { Channel, ChannelConnectionTestResult } from "./types.js";

function fakeChannel(id: string, events: string[], updates: unknown[] = []): Channel {
  return {
    id,
    async start() {
      events.push(`${id}:start`);
    },
    async stop() {
      events.push(`${id}:stop`);
    },
    updateConfig(config: unknown) {
      updates.push(config);
    },
    getStatus() {
      return { id, status: "connected", activeSessions: 1 };
    },
  };
}

function fakeTestableChannel(id: string, result: ChannelConnectionTestResult): Channel {
  return {
    ...fakeChannel(id, []),
    async testConnection() {
      return result;
    },
  };
}

describe("ChannelManager", () => {
  test("starts and stops all channels", async () => {
    const events: string[] = [];
    const manager = new ChannelManager({
      channels: [fakeChannel("feishu", events)],
    });

    await manager.start();
    await manager.stop();

    expect(events).toEqual(["feishu:start", "feishu:stop"]);
  });

  test("returns status for Web UI", () => {
    const manager = new ChannelManager({
      channels: [fakeChannel("feishu", [])],
    });

    expect(manager.getStatus()).toEqual({
      channels: [{ id: "feishu", status: "connected", activeSessions: 1 }],
    });
  });

  test("tests a single channel connection", async () => {
    const manager = new ChannelManager({
      channels: [
        fakeTestableChannel("feishu:donghao", {
          ok: true,
          latencyMs: 18,
          checks: [{ name: "tenant_access_token", ok: true }],
        }),
      ],
    });

    await expect(manager.testChannelConnection("feishu:donghao")).resolves.toEqual({
      ok: true,
      latencyMs: 18,
      checks: [{ name: "tenant_access_token", ok: true }],
    });
    await expect(manager.testChannelConnection("feishu:missing")).resolves.toMatchObject({
      ok: false,
      error: "Channel not found.",
    });
  });

  test("builds default Feishu channel from env config", () => {
    let config: FeishuConfig | undefined;
    const manager = new ChannelManager({
      cwd: "/tmp/project",
      model: "or@gpt-5",
      env: {
        FEISHU_APP_ID: "cli_a",
        FEISHU_APP_SECRET: "secret",
        CLAUDISH_FEISHU_BOT_OPEN_ID: "ou_bot",
      },
      configPath: join(tmpdir(), "claudish-missing-config.yaml"),
      createFeishuChannel(input) {
        config = input;
        return fakeChannel("feishu", []);
      },
    });

    expect(config).toMatchObject({
      enabled: true,
      appId: "cli_a",
      appSecret: "secret",
      botOpenId: "ou_bot",
      cwd: "/tmp/project",
      model: "or@gpt-5",
    });
    expect(manager.getStatus().channels[0].id).toBe("feishu");
  });

  test("builds default Feishu channel from loaded config.yaml", () => {
    let config: FeishuConfig | undefined;
    const manager = new ChannelManager({
      config: {
        service: { port: 18123, cwd: "/tmp/service" },
        channels: {
          feishu: {
            enabled: true,
            status: "configured",
            appId: "cli_yaml",
            appSecret: "yaml_secret",
            botOpenId: "ou_yaml",
            domain: "lark",
            model: "yaml-model",
            cwd: "/tmp/feishu",
          },
        },
      },
      createFeishuChannel(input) {
        config = input;
        return fakeChannel("feishu", []);
      },
    });

    expect(config).toMatchObject({
      enabled: true,
      appId: "cli_yaml",
      appSecret: "yaml_secret",
      botOpenId: "ou_yaml",
      domain: "lark",
      model: "yaml-model",
      cwd: "/tmp/feishu",
    });
    expect(manager.getStatus().channels[0].id).toBe("feishu");
  });

  test("builds one Feishu channel for each configured account", () => {
    const configs: FeishuConfig[] = [];
    const manager = new ChannelManager({
      config: {
        service: { port: 18123, cwd: "/tmp/service" },
        channels: {
          feishu: {
            id: "default",
            enabled: false,
            status: "not_configured",
            domain: "feishu",
            model: "cx@gpt-5.5",
            cwd: "/tmp/service",
            sessionMode: "headless",
            history: { persist: true, maxMessages: 50, nativeResume: true },
          },
          feishuAccounts: [
            {
              id: "donghao",
              enabled: true,
              status: "configured",
              appId: "cli_donghao",
              appSecret: "secret_donghao",
              botOpenId: "ou_donghao",
              domain: "feishu",
              model: "cx@gpt-5.5",
              cwd: "/tmp/service/donghao",
              sessionMode: "headless",
              history: { persist: true, maxMessages: 50, nativeResume: true },
            },
            {
              id: "team",
              enabled: true,
              status: "configured",
              appId: "cli_team",
              appSecret: "secret_team",
              botOpenId: "ou_team",
              domain: "feishu",
              model: "cx@gpt-5.5",
              cwd: "/tmp/service/team",
              sessionMode: "headless",
              history: { persist: true, maxMessages: 50, nativeResume: true },
            },
          ],
        },
      },
      createFeishuChannel(input) {
        configs.push(input);
        return fakeChannel(`feishu:${input.id}`, []);
      },
    });

    expect(configs.map((config) => config.id)).toEqual(["donghao", "team"]);
    expect(manager.getStatus().channels.map((channel) => channel.id)).toEqual([
      "feishu:donghao",
      "feishu:team",
    ]);
  });

  test("hot reloads Feishu accounts by adding, removing, and restarting changed apps", async () => {
    const events: string[] = [];
    const created: string[] = [];
    const manager = new ChannelManager({
      config: buildConfig([
        buildFeishuConfig({ id: "donghao", appId: "cli_old" }),
        buildFeishuConfig({ id: "team", appId: "cli_team" }),
      ]),
      createFeishuChannel(input) {
        created.push(`${input.id}:${input.appId}`);
        return fakeChannel(`feishu:${input.id}`, events);
      },
    });
    await manager.start();

    const result = await manager.reloadConfig(
      buildConfig([
        buildFeishuConfig({ id: "donghao", appId: "cli_new" }),
        buildFeishuConfig({ id: "newbot", appId: "cli_newbot" }),
      ])
    );

    expect(result).toMatchObject({
      added: ["feishu:newbot"],
      removed: ["feishu:team"],
      restarted: ["feishu:donghao"],
    });
    expect(created).toEqual([
      "donghao:cli_old",
      "team:cli_team",
      "donghao:cli_new",
      "newbot:cli_newbot",
    ]);
    expect(events).toEqual([
      "feishu:donghao:start",
      "feishu:team:start",
      "feishu:team:stop",
      "feishu:donghao:stop",
      "feishu:donghao:start",
      "feishu:newbot:start",
    ]);
    expect(manager.getStatus().channels.map((channel) => channel.id)).toEqual([
      "feishu:donghao",
      "feishu:newbot",
    ]);
  });

  test("hot reloads Feishu runtime switches without restarting the channel", async () => {
    const events: string[] = [];
    const updates: unknown[] = [];
    const manager = new ChannelManager({
      config: buildConfig([buildFeishuConfig({ id: "donghao", sendProgressReplies: false })]),
      createFeishuChannel(input) {
        return fakeChannel(`feishu:${input.id}`, events, updates);
      },
    });
    await manager.start();

    const result = await manager.reloadConfig(
      buildConfig([buildFeishuConfig({ id: "donghao", sendProgressReplies: true })])
    );

    expect(result).toMatchObject({
      updated: ["feishu:donghao"],
      restarted: [],
    });
    expect(events).toEqual(["feishu:donghao:start"]);
    expect(updates).toEqual([
      expect.objectContaining({
        id: "donghao",
        sendProgressReplies: true,
      }),
    ]);
  });
});

function buildConfig(accounts: FeishuConfig[]) {
  return {
    service: { port: 18123, cwd: "/tmp/service" },
    channels: {
      feishu: buildFeishuConfig({ id: "default", enabled: false }),
      feishuAccounts: accounts,
    },
  };
}

function buildFeishuConfig(overrides: Partial<FeishuConfig>): FeishuConfig {
  return {
    id: "donghao",
    enabled: true,
    status: "configured",
    appId: "cli_donghao",
    appSecret: "secret_donghao",
    botOpenId: "ou_donghao",
    domain: "feishu",
    model: "cx@gpt-5.5",
    cwd: "/tmp/service/donghao",
    sessionMode: "headless",
    sendProgressReplies: false,
    history: { persist: true, maxMessages: 50, nativeResume: true },
    ...overrides,
  };
}
