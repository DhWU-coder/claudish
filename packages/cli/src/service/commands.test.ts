import { describe, expect, test } from "bun:test";
import { formatStartResult, formatStatus } from "./commands.js";
import type { ServiceState } from "./state.js";

const runningState: ServiceState = {
  pid: process.pid,
  startedAt: "2026-06-23T00:00:00.000Z",
  host: "127.0.0.1",
  port: 17888,
  webUrl: "http://127.0.0.1:17888/",
  logPath: "/tmp/claudish.log",
  cwd: "/tmp/project",
  channels: { feishu: { status: "connected" } },
};

describe("service commands", () => {
  test("formatStatus shows stopped when state is missing", () => {
    expect(formatStatus(null)).toContain("stopped");
  });

  test("formatStatus shows running pid and web url", () => {
    const output = formatStatus(runningState);

    expect(output).toContain(`pid ${process.pid}`);
    expect(output).toContain("http://127.0.0.1:17888/");
  });

  test("formatStartResult includes port fallback warning", () => {
    const output = formatStartResult({
      state: runningState,
      warning: "Warning: service port 17888 is unavailable, using 17889 instead.",
    });

    expect(output).toContain("Warning: service port 17888");
    expect(output).toContain("http://127.0.0.1:17888/");
  });
});
