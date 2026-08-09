const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  findBun,
  getBunCandidates,
  getBunLocator,
  getInstallInstructions,
  parseLocatorOutput,
} = require("../bin/claudish.cjs");

describe("Claudish 跨平台启动器", () => {
  test("Windows 使用 where.exe 并包含用户目录下的 bun.exe", () => {
    assert.deepEqual(getBunLocator("win32"), {
      command: "where.exe",
      args: ["bun"],
    });
    assert.deepEqual(
      getBunCandidates("win32", {
        USERPROFILE: "C:\\Users\\tester",
      }),
      ["C:\\Users\\tester\\.bun\\bin\\bun.exe"],
    );
  });

  test("Windows 优先支持 BUN_INSTALL 且不会生成 undefined 路径", () => {
    const candidates = getBunCandidates("win32", {
      BUN_INSTALL: "D:\\Tools\\bun",
    });

    assert.deepEqual(candidates, ["D:\\Tools\\bun\\bin\\bun.exe"]);
    assert.equal(candidates.some((candidate) => candidate.includes("undefined")), false);
  });

  test("macOS 与 Linux 保留 Unix 定位命令和 Homebrew 路径", () => {
    assert.deepEqual(getBunLocator("darwin"), {
      command: "which",
      args: ["bun"],
    });
    assert.deepEqual(getBunCandidates("darwin", { HOME: "/Users/tester" }), [
      "/Users/tester/.bun/bin/bun",
      "/usr/local/bin/bun",
      "/opt/homebrew/bin/bun",
    ]);
  });

  test("定位命令输出兼容 Windows 多行结果", () => {
    assert.equal(
      parseLocatorOutput("C:\\Users\\tester\\.bun\\bin\\bun.exe\r\nC:\\bin\\bun.exe\r\n"),
      "C:\\Users\\tester\\.bun\\bin\\bun.exe",
    );
  });

  test("Windows 能通过 where.exe 的结果找到 Bun", () => {
    const calls = [];
    const result = findBun({
      platform: "win32",
      env: {},
      runtimeVersions: {},
      runtimeExecutable: "",
      execFile(command, args) {
        calls.push({ command, args });
        return "C:\\Users\\tester\\.bun\\bin\\bun.exe\r\n";
      },
    });

    assert.equal(result, "C:\\Users\\tester\\.bun\\bin\\bun.exe");
    assert.deepEqual(calls, [{ command: "where.exe", args: ["bun"] }]);
  });

  test("安装提示按平台返回官方命令", () => {
    assert.match(getInstallInstructions("win32"), /powershell/u);
    assert.match(getInstallInstructions("darwin"), /curl/u);
  });
});
