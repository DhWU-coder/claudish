import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadClaudishConfig } from "./config.js";

let home: string;
const originalHome = process.env.CLAUDISH_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudish-config-"));
  process.env.CLAUDISH_HOME = home;
});

afterEach(() => {
  process.env.CLAUDISH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("claudish config.yaml", () => {
  test("missing config.yaml uses ~/.claudish/workspace default and env fallback", () => {
    const config = loadClaudishConfig({
      configPath: join(home, "missing.yaml"),
      env: {
        CLAUDISH_SERVICE_PORT: "18000",
        CLAUDISH_MODEL: "or@gpt-5",
      },
    });

    expect(config.service).toEqual({
      port: 18000,
      cwd: join(home, "workspace"),
    });
    expect(config.channels.feishu).toMatchObject({
      enabled: false,
      status: "not_configured",
      domain: "feishu",
      model: "or@gpt-5",
      cwd: join(home, "workspace"),
    });
  });

  test("expands tilde in configured service cwd", () => {
    const configPath = join(home, "config.yaml");
    writeFileSync(configPath, "service:\n  cwd: ~/.claudish/workspace\n");

    const config = loadClaudishConfig({
      configPath,
      env: {},
    });

    expect(config.service.cwd).toBe(join(homedir(), ".claudish", "workspace"));
    expect(config.channels.feishu.cwd).toBe(join(homedir(), ".claudish", "workspace"));
  });

  test("reads service and Feishu settings from config.yaml", () => {
    const configPath = join(home, "config.yaml");
    writeFileSync(
      configPath,
      [
        "service:",
        "  port: 18123",
        "  cwd: /tmp/service-project",
        "channels:",
        "  feishu:",
        "    enabled: true",
        "    appId: cli_yaml",
        "    appSecret: yaml_secret",
        "    botOpenId: ou_yaml",
        "    domain: lark",
        "    model: cx@gpt-5.5",
        "    cwd: /tmp/feishu-project",
        "    sessionMode: headless",
        "    sendProgressReplies: true",
        "    history:",
        "      persist: true",
        "      maxMessages: 80",
        "      nativeResume: true",
      ].join("\n")
    );

    const config = loadClaudishConfig({
      cwd: "/tmp/default-project",
      configPath,
      env: {},
    });

    expect(config.service).toEqual({
      port: 18123,
      cwd: "/tmp/service-project",
    });
    expect(config.channels.feishu).toMatchObject({
      enabled: true,
      status: "configured",
      appId: "cli_yaml",
      appSecret: "yaml_secret",
      botOpenId: "ou_yaml",
      domain: "lark",
      model: "cx@gpt-5.5",
      cwd: "/tmp/feishu-project",
      sessionMode: "headless",
      sendProgressReplies: true,
      history: {
        persist: true,
        maxMessages: 80,
        nativeResume: true,
      },
    });
  });

  test("reads multiple Feishu accounts and defaults account cwd by id", () => {
    const configPath = join(home, "config.yaml");
    writeFileSync(
      configPath,
      [
        "service:",
        "  cwd: /tmp/service-project",
        "channels:",
        "  feishu:",
        "    accounts:",
        "      - id: donghao",
        "        appId: cli_donghao",
        "        appSecret: secret_donghao",
        "        botOpenId: ou_donghao",
        "      - id: team",
        "        appId: cli_team",
        "        appSecret: secret_team",
        "        cwd: /tmp/team-feishu",
      ].join("\n")
    );

    const config = loadClaudishConfig({
      configPath,
      env: {},
    });

    expect(config.channels.feishuAccounts).toHaveLength(2);
    expect(config.channels.feishuAccounts[0]).toMatchObject({
      id: "donghao",
      appId: "cli_donghao",
      appSecret: "secret_donghao",
      botOpenId: "ou_donghao",
      cwd: join(home, "workspace", "donghao"),
    });
    expect(config.channels.feishuAccounts[1]).toMatchObject({
      id: "team",
      appId: "cli_team",
      appSecret: "secret_team",
      cwd: "/tmp/team-feishu",
    });
  });

  test("rejects duplicate Feishu account ids", () => {
    const configPath = join(home, "config.yaml");
    writeFileSync(
      configPath,
      [
        "channels:",
        "  feishu:",
        "    accounts:",
        "      - id: same",
        "        appId: cli_a",
        "        appSecret: secret_a",
        "      - id: same",
        "        appId: cli_b",
        "        appSecret: secret_b",
      ].join("\n")
    );

    expect(() =>
      loadClaudishConfig({
        configPath,
        env: {},
      })
    ).toThrow("Duplicate Feishu account id: same");
  });

  test("config.yaml values override env and Feishu cwd inherits service cwd", () => {
    const configPath = join(home, "config.yaml");
    writeFileSync(
      configPath,
      [
        "service:",
        "  port: 18123",
        "  cwd: /tmp/yaml-service",
        "channels:",
        "  feishu:",
        "    appId: cli_yaml",
        "    appSecret: yaml_secret",
        "    model: yaml-model",
      ].join("\n")
    );

    const config = loadClaudishConfig({
      cwd: "/tmp/default-project",
      configPath,
      env: {
        CLAUDISH_SERVICE_PORT: "19000",
        FEISHU_APP_ID: "cli_env",
        FEISHU_APP_SECRET: "env_secret",
        CLAUDISH_FEISHU_MODEL: "env-model",
        CLAUDISH_FEISHU_CWD: "/tmp/env-feishu",
      },
    });

    expect(config.service).toEqual({
      port: 18123,
      cwd: "/tmp/yaml-service",
    });
    expect(config.channels.feishu).toMatchObject({
      appId: "cli_yaml",
      appSecret: "yaml_secret",
      model: "yaml-model",
      cwd: "/tmp/yaml-service",
    });
  });

  test("invalid config.yaml throws a readable error", () => {
    const configPath = join(home, "config.yaml");
    writeFileSync(configPath, "service:\n  port: [");

    expect(() =>
      loadClaudishConfig({
        cwd: "/tmp/default-project",
        configPath,
        env: {},
      })
    ).toThrow("Failed to read claudish config.yaml");
  });
});
