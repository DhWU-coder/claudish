import { describe, expect, test } from "bun:test";
import { loadFeishuConfig } from "./config.js";

describe("Feishu config", () => {
  test("missing app credentials returns disabled not_configured config", () => {
    expect(loadFeishuConfig({}, { model: "cx@gpt-5.5", cwd: "/tmp/project" })).toMatchObject({
      enabled: false,
      status: "not_configured",
      model: "cx@gpt-5.5",
      cwd: "/tmp/project",
      sessionMode: "headless",
      history: {
        persist: true,
        maxMessages: 50,
        nativeResume: true,
      },
    });
  });

  test("accepts lark domain", () => {
    expect(
      loadFeishuConfig(
        {
          FEISHU_APP_ID: "cli_a",
          FEISHU_APP_SECRET: "secret",
          FEISHU_DOMAIN: "lark",
        },
        { model: "cx@gpt-5.5", cwd: "/tmp/project" }
      )
    ).toMatchObject({
      enabled: true,
      domain: "lark",
    });
  });

  test("CLAUDISH_FEISHU_CWD and CLAUDISH_FEISHU_MODEL override defaults", () => {
    expect(
      loadFeishuConfig(
        {
          FEISHU_APP_ID: "cli_a",
          FEISHU_APP_SECRET: "secret",
          CLAUDISH_FEISHU_CWD: "/tmp/feishu",
          CLAUDISH_FEISHU_MODEL: "or@gpt-5",
        },
        { model: "cx@gpt-5.5", cwd: "/tmp/project" }
      )
    ).toMatchObject({
      enabled: true,
      model: "or@gpt-5",
      cwd: "/tmp/feishu",
    });
  });

  test("config.yaml values override env and defaults", () => {
    expect(
      loadFeishuConfig(
        {
          FEISHU_APP_ID: "cli_env",
          FEISHU_APP_SECRET: "env_secret",
          FEISHU_DOMAIN: "feishu",
          CLAUDISH_FEISHU_CWD: "/tmp/env",
          CLAUDISH_FEISHU_MODEL: "env-model",
        },
        { model: "cx@gpt-5.5", cwd: "/tmp/project" },
        {
          appId: "cli_yaml",
          appSecret: "yaml_secret",
          botOpenId: "ou_yaml",
          domain: "lark",
          model: "yaml-model",
          cwd: "/tmp/yaml",
        }
      )
    ).toMatchObject({
      enabled: true,
      status: "configured",
      appId: "cli_yaml",
      appSecret: "yaml_secret",
      botOpenId: "ou_yaml",
      domain: "lark",
      model: "yaml-model",
      cwd: "/tmp/yaml",
    });
  });

  test("config.yaml enabled false disables Feishu even with credentials", () => {
    expect(
      loadFeishuConfig(
        {
          FEISHU_APP_ID: "cli_env",
          FEISHU_APP_SECRET: "env_secret",
        },
        { model: "cx@gpt-5.5", cwd: "/tmp/project" },
        {
          enabled: false,
          appId: "cli_yaml",
          appSecret: "yaml_secret",
        }
      )
    ).toMatchObject({
      enabled: false,
      status: "not_configured",
      appId: "cli_yaml",
      appSecret: "yaml_secret",
    });
  });

  test("config.yaml reads headless session and history settings", () => {
    expect(
      loadFeishuConfig(
        {
          FEISHU_APP_ID: "cli_env",
          FEISHU_APP_SECRET: "env_secret",
        },
        { model: "cx@gpt-5.5", cwd: "/tmp/project" },
        {
          sessionMode: "terminal",
          history: {
            persist: false,
            maxMessages: 12,
            nativeResume: false,
          },
        }
      )
    ).toMatchObject({
      sessionMode: "terminal",
      history: {
        persist: false,
        maxMessages: 12,
        nativeResume: false,
      },
    });
  });
});
