#!/usr/bin/env node

// 启动器先定位 Bun，再使用 Bun 执行真正的 Claudish 入口。
// Claudish 使用了 Bun 专属 API，不能直接由 Node.js 执行业务入口。

const { execFileSync } = require("child_process");
const { posix, resolve, win32 } = require("path");

function getBunLocator(platform) {
  if (platform === "win32") {
    return { command: "where.exe", args: ["bun"] };
  }

  return { command: "which", args: ["bun"] };
}

function parseLocatorOutput(output) {
  return String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

function getBunCandidates(platform, env) {
  const isWindows = platform === "win32";
  const pathApi = isWindows ? win32 : posix;
  const executableName = isWindows ? "bun.exe" : "bun";
  const homeDirectory = env.HOME || env.USERPROFILE;
  const candidates = [];

  if (env.BUN_INSTALL) {
    candidates.push(pathApi.join(env.BUN_INSTALL, "bin", executableName));
  }

  if (homeDirectory) {
    candidates.push(pathApi.join(homeDirectory, ".bun", "bin", executableName));
  }

  if (!isWindows) {
    candidates.push("/usr/local/bin/bun", "/opt/homebrew/bin/bun");
  }

  return [...new Set(candidates)];
}

function canRunBun(candidate, execFile) {
  try {
    execFile(candidate, ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function findBun(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const execFile = options.execFile ?? execFileSync;
  const runtimeVersions = options.runtimeVersions ?? process.versions;
  const runtimeExecutable = options.runtimeExecutable ?? process.execPath;

  if (runtimeVersions.bun && runtimeExecutable) {
    return runtimeExecutable;
  }

  const locator = getBunLocator(platform);
  try {
    const output = execFile(locator.command, locator.args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const locatedPath = parseLocatorOutput(output);
    if (locatedPath) {
      return locatedPath;
    }
  } catch {
    // 定位命令不可用时继续检查常见安装目录。
  }

  for (const candidate of getBunCandidates(platform, env)) {
    if (canRunBun(candidate, execFile)) {
      return candidate;
    }
  }

  return null;
}

function getInstallInstructions(platform) {
  if (platform === "win32") {
    return 'powershell -c "irm https://bun.com/install.ps1 | iex"';
  }

  return "curl -fsSL https://bun.com/install | bash";
}

function main() {
  const bun = findBun();
  if (!bun) {
    console.error(`claudish requires the Bun runtime but it was not found.

Install Bun:
  ${getInstallInstructions(process.platform)}

Then retry:
  claudish --version

Learn more: https://bun.com`);
    process.exit(1);
  }

  const entry = resolve(__dirname, "..", "dist", "index.js");
  try {
    const result = require("child_process").spawnSync(
      bun,
      [entry, ...process.argv.slice(2)],
      {
        stdio: "inherit",
        env: process.env,
        windowsHide: false,
      },
    );

    if (result.error) {
      throw result.error;
    }

    process.exit(result.status ?? 1);
  } catch (error) {
    console.error("Failed to start claudish:", error.message);
    process.exit(1);
  }
}

module.exports = {
  findBun,
  getBunCandidates,
  getBunLocator,
  getInstallInstructions,
  parseLocatorOutput,
};

if (require.main === module) {
  main();
}
