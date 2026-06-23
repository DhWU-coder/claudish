import { describe, expect, test } from "bun:test";
import { buildDaemonArgs } from "./process.js";

describe("service process", () => {
  test("buildDaemonArgs includes hidden daemon flags", () => {
    expect(
      buildDaemonArgs({
        cwd: "/tmp/project",
        port: 17888,
      })
    ).toEqual(["--service-daemon", "--service-port", "17888", "--service-cwd", "/tmp/project"]);
  });
});
