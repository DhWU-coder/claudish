import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUsageDashboard } from "./web-usage-service.js";

let tempRoot: string | undefined;

afterEach(() => {
  // Each test owns its fake project root, including the local usage directory.
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

function createUsageRoot(): string {
  // The dashboard reads the same project-local folder used by the writer.
  tempRoot = mkdtempSync(join(tmpdir(), "claudish-web-usage-"));
  mkdirSync(join(tempRoot, ".claudish-usage"), { recursive: true });
  return tempRoot;
}

function writeUsageJsonl(projectRoot: string, lines: string[]): void {
  // JSONL lets the dashboard skip bad rows without losing good usage events.
  writeFileSync(join(projectRoot, ".claudish-usage", "usage.jsonl"), `${lines.join("\n")}\n`);
}

describe("web usage service", () => {
  test("returns an empty dashboard when the local usage log does not exist", () => {
    const projectRoot = createUsageRoot();
    rmSync(join(projectRoot, ".claudish-usage"), { recursive: true, force: true });

    const dashboard = getUsageDashboard({ projectRoot });

    // Empty projects should render a real dashboard shell with zero counters.
    expect(dashboard.projectRoot).toBe(projectRoot);
    expect(dashboard.totalRequests).toBe(0);
    expect(dashboard.totals).toEqual({
      total: 0,
      input: 0,
      cached: 0,
      output: 0,
      reasoning: 0,
    });
    expect(dashboard.byProvider).toEqual([]);
    expect(dashboard.recent).toEqual([]);
  });

  test("aggregates valid Claudish usage rows by provider model and cwd", () => {
    const projectRoot = createUsageRoot();
    writeUsageJsonl(projectRoot, [
      JSON.stringify({
        schema_version: "claudish-usage.project-log.v1",
        timestamp: "2026-06-17T08:00:00.000Z",
        provider: "cx",
        model: "gpt-5.5",
        api_surface: "chatgpt-codex-responses",
        cwd: "/repo/default",
        request_id: "older",
        usage: { total: 120, input: 70, cached: 10, output: 50, reasoning: 15 },
      }),
      JSON.stringify({
        schema_version: "claudish-usage.project-log.v1",
        timestamp: "2026-06-17T09:00:00.000Z",
        provider: "aigateway",
        model: "claude-opus-4-7",
        api_surface: "openai-chat-completions",
        cwd: "/repo/other",
        request_id: "newer",
        usage: { total: 210, input: 130, cached: 20, output: 80, reasoning: 0 },
      }),
      "{ bad json",
      JSON.stringify({
        schema_version: "codex-usage.project-log.v1",
        provider: "codex",
        model: "ignored",
        usage: { total: 999, input: 999, cached: 0, output: 0, reasoning: 0 },
      }),
    ]);

    const dashboard = getUsageDashboard({ projectRoot, recentLimit: 1 });

    // Only Claudish usage rows are counted, keeping codex-usage data separate.
    expect(dashboard.totalRequests).toBe(2);
    expect(dashboard.totals).toEqual({
      total: 330,
      input: 200,
      cached: 30,
      output: 130,
      reasoning: 15,
    });
    expect(dashboard.byProvider).toEqual([
      {
        name: "aigateway",
        requests: 1,
        usage: { total: 210, input: 130, cached: 20, output: 80, reasoning: 0 },
      },
      {
        name: "cx",
        requests: 1,
        usage: { total: 120, input: 70, cached: 10, output: 50, reasoning: 15 },
      },
    ]);
    expect(dashboard.byModel.map((row) => row.name)).toEqual([
      "aigateway@claude-opus-4-7",
      "cx@gpt-5.5",
    ]);
    expect(dashboard.byCwd.map((row) => row.name)).toEqual(["/repo/other", "/repo/default"]);
    expect(dashboard.recent).toEqual([
      {
        timestamp: "2026-06-17T09:00:00.000Z",
        provider: "aigateway",
        model: "claude-opus-4-7",
        cwd: "/repo/other",
        apiSurface: "openai-chat-completions",
        requestId: "newer",
        usage: { total: 210, input: 130, cached: 20, output: 80, reasoning: 0 },
      },
    ]);
  });

  test("filters usage by recent range and groups timeline buckets", () => {
    const projectRoot = createUsageRoot();
    writeUsageJsonl(projectRoot, [
      JSON.stringify({
        schema_version: "claudish-usage.project-log.v1",
        timestamp: "2026-06-10T08:00:00.000Z",
        provider: "cx",
        model: "old-model",
        cwd: "/repo/old",
        usage: { total: 999, input: 900, cached: 0, output: 99, reasoning: 0 },
      }),
      JSON.stringify({
        schema_version: "claudish-usage.project-log.v1",
        timestamp: "2026-06-16T08:00:00.000Z",
        provider: "cx",
        model: "gpt-5.5",
        cwd: "/repo/default",
        usage: { total: 100, input: 60, cached: 10, output: 40, reasoning: 5 },
      }),
      JSON.stringify({
        schema_version: "claudish-usage.project-log.v1",
        timestamp: "2026-06-17T08:00:00.000Z",
        provider: "aigateway",
        model: "gpt-5.5",
        cwd: "/repo/default",
        usage: { total: 200, input: 120, cached: 20, output: 80, reasoning: 8 },
      }),
      JSON.stringify({
        schema_version: "claudish-usage.project-log.v1",
        timestamp: "2026-06-17T09:00:00.000Z",
        provider: "cx",
        model: "gpt-5.5",
        cwd: "/repo/default",
        usage: { total: 50, input: 40, cached: 5, output: 10, reasoning: 1 },
      }),
    ]);

    const dashboard = getUsageDashboard({
      projectRoot,
      preset: "recent",
      recentValue: "2天",
      bucket: "day",
      now: "2026-06-17T12:00:00.000Z",
    });

    // Recent filtering should drive every aggregate and leave old rows out.
    expect(dashboard.range.preset).toBe("recent");
    expect(dashboard.range.bucket).toBe("day");
    expect(dashboard.totalRequests).toBe(3);
    expect(dashboard.totals.total).toBe(350);
    expect(dashboard.byModel.map((row) => row.name)).toEqual(["aigateway@gpt-5.5", "cx@gpt-5.5"]);
    expect(dashboard.timeline.map((row) => [row.key, row.usage.total])).toEqual([
      ["2026-06-16", 100],
      ["2026-06-17", 250],
    ]);
    expect(dashboard.timeline[1].providers.map((row) => [row.name, row.usage.total])).toEqual([
      ["aigateway", 200],
      ["cx", 50],
    ]);
  });

  test("filters only the model distribution by selected provider", () => {
    const projectRoot = createUsageRoot();
    writeUsageJsonl(projectRoot, [
      JSON.stringify({
        schema_version: "claudish-usage.project-log.v1",
        timestamp: "2026-06-17T08:00:00.000Z",
        provider: "cx",
        model: "gpt-5.5",
        cwd: "/repo/default",
        usage: { total: 100, input: 60, cached: 10, output: 40, reasoning: 5 },
      }),
      JSON.stringify({
        schema_version: "claudish-usage.project-log.v1",
        timestamp: "2026-06-17T09:00:00.000Z",
        provider: "aigateway",
        model: "gpt-5.5",
        cwd: "/repo/default",
        usage: { total: 200, input: 120, cached: 20, output: 80, reasoning: 8 },
      }),
    ]);

    const dashboard = getUsageDashboard({ projectRoot, modelProvider: "cx" });

    // Provider filtering is scoped to model rows; totals and provider rows stay global.
    expect(dashboard.totalRequests).toBe(2);
    expect(dashboard.totals.total).toBe(300);
    expect(dashboard.byProvider.map((row) => row.name)).toEqual(["aigateway", "cx"]);
    expect(dashboard.modelProviderOptions).toEqual(["aigateway", "cx"]);
    expect(dashboard.modelProvider).toBe("cx");
    expect(dashboard.byModel.map((row) => [row.name, row.usage.total])).toEqual([
      ["cx@gpt-5.5", 100],
    ]);
  });
});
