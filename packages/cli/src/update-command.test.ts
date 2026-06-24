import { describe, expect, test } from "bun:test";
import {
  buildRepositoryUpdateSteps,
  findRepositoryRootFromEntry,
  getRepositoryUpdatePreflight,
} from "./update-command.js";

describe("私有仓库自动更新命令", () => {
  test("更新步骤只使用当前仓库和 Bun 构建，不使用 npm 公网包", () => {
    const steps = buildRepositoryUpdateSteps("/repo/claudish");

    expect(steps.map((step) => [step.command, step.args, step.cwd])).toEqual([
      ["git", ["pull", "--ff-only"], "/repo/claudish"],
      ["bun", ["install"], "/repo/claudish"],
      ["bun", ["run", "build:cli"], "/repo/claudish"],
    ]);

    const rendered = steps.map((step) => `${step.command} ${step.args.join(" ")}`).join("\n");
    expect(rendered).not.toContain("npm");
    expect(rendered).not.toContain("claudish@latest");
    expect(rendered).not.toContain("registry.npmjs.org");
  });

  test("从当前入口文件定位所属 Git 仓库根目录", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const root = findRepositoryRootFromEntry(
      "/repo/claudish/packages/cli/dist/index.js",
      (command, args) => {
        calls.push({ command, args });
        return "/repo/claudish\n";
      }
    );

    expect(root).toBe("/repo/claudish");
    expect(calls).toEqual([
      {
        command: "git",
        args: ["-C", "/repo/claudish/packages/cli/dist", "rev-parse", "--show-toplevel"],
      },
    ]);
  });

  test("工作区不干净时拒绝自动更新", () => {
    const result = getRepositoryUpdatePreflight("/repo/claudish", (command, args) => {
      if (command !== "git") throw new Error("只应该调用 git");
      if (args.includes("status")) return " M packages/cli/src/index.ts\n";
      if (args.includes("rev-parse")) return "origin/main\n";
      throw new Error(`未预期的命令: ${args.join(" ")}`);
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("未提交改动");
    }
  });
});
