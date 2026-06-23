import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  getDefaultWorkspacePath,
  getServiceLogPath,
  getServiceStatePath,
  resolveClaudishHome,
} from "./paths.js";

const originalHome = process.env.CLAUDISH_HOME;

afterEach(() => {
  process.env.CLAUDISH_HOME = originalHome;
});

describe("service paths", () => {
  test("uses CLAUDISH_HOME when set", () => {
    process.env.CLAUDISH_HOME = "/tmp/claudish-home";

    expect(resolveClaudishHome()).toBe("/tmp/claudish-home");
    expect(getServiceStatePath()).toBe(join("/tmp/claudish-home", "service.json"));
    expect(getServiceLogPath()).toBe(join("/tmp/claudish-home", "logs", "service.log"));
    expect(getDefaultWorkspacePath()).toBe(join("/tmp/claudish-home", "workspace"));
  });
});
