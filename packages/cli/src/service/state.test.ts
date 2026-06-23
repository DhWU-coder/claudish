import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isProcessRunning,
  isStateRunning,
  readServiceState,
  removeServiceState,
  writeServiceState,
} from "./state.js";

let home: string;
const originalHome = process.env.CLAUDISH_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudish-service-state-"));
  process.env.CLAUDISH_HOME = home;
});

afterEach(() => {
  process.env.CLAUDISH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("service state", () => {
  test("writes, reads, and removes service state", () => {
    writeServiceState({
      pid: 123,
      startedAt: "2026-06-23T00:00:00.000Z",
      host: "127.0.0.1",
      port: 17888,
      webUrl: "http://127.0.0.1:17888/",
      logPath: join(home, "logs", "service.log"),
      cwd: "/tmp/project",
      channels: {},
    });

    expect(readServiceState()?.pid).toBe(123);
    removeServiceState();
    expect(readServiceState()).toBeNull();
  });

  test("treats the current process as running", () => {
    expect(isProcessRunning(process.pid)).toBe(true);
    expect(
      isStateRunning({
        pid: process.pid,
        startedAt: "2026-06-23T00:00:00.000Z",
        host: "127.0.0.1",
        port: 17888,
        webUrl: "http://127.0.0.1:17888/",
        logPath: join(home, "logs", "service.log"),
        cwd: "/tmp/project",
        channels: {},
      })
    ).toBe(true);
  });
});
