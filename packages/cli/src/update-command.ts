/**
 * 私有仓库自动更新命令。
 *
 * 这个版本不再把 npm 公网包作为更新源，而是只更新当前运行入口所属的
 * Git 仓库，适合长期维护自己的 claudish 分支。
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getVersion } from "./cli.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

export interface RepositoryUpdateStep {
  label: string;
  command: string;
  args: string[];
  cwd: string;
}

export type RepositoryUpdatePreflight =
  | { ok: true; upstream: string }
  | { ok: false; reason: string };

type CommandRunner = (command: string, args: string[]) => string;

function runCommand(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runUpdateStep(step: RepositoryUpdateStep): void {
  execFileSync(step.command, step.args, {
    cwd: step.cwd,
    stdio: "inherit",
  });
}

function normalizeEntryPath(entryPath: string): string {
  const absolutePath = resolve(entryPath);
  return existsSync(absolutePath) ? realpathSync(absolutePath) : absolutePath;
}

/**
 * 从当前 CLI 入口文件向上定位 Git 仓库根目录。
 */
export function findRepositoryRootFromEntry(
  entryPath = process.argv[1] || "",
  runner: CommandRunner = runCommand
): string | null {
  if (!entryPath) return null;

  const entryDir = dirname(normalizeEntryPath(entryPath));

  try {
    const root = runner("git", ["-C", entryDir, "rev-parse", "--show-toplevel"]).trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * 自动更新前检查工作区状态，避免在有本地改动时拉取远端代码。
 */
export function getRepositoryUpdatePreflight(
  repoRoot: string,
  runner: CommandRunner = runCommand
): RepositoryUpdatePreflight {
  try {
    const status = runner("git", ["-C", repoRoot, "status", "--porcelain"]);
    if (status.trim()) {
      return {
        ok: false,
        reason: "当前仓库有未提交改动。请先提交、stash 或清理这些改动后再运行 claudish update。",
      };
    }
  } catch {
    return {
      ok: false,
      reason: "无法读取 Git 工作区状态。请确认当前 claudish 来自一个可用的 Git 仓库。",
    };
  }

  try {
    const upstream = runner("git", [
      "-C",
      repoRoot,
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]).trim();

    if (!upstream) {
      return {
        ok: false,
        reason: "当前分支没有 upstream。请先设置远端跟踪分支后再运行 claudish update。",
      };
    }

    return { ok: true, upstream };
  } catch {
    return {
      ok: false,
      reason: "当前分支没有 upstream。请先设置远端跟踪分支后再运行 claudish update。",
    };
  }
}

/**
 * 构建私有仓库自动更新步骤。
 */
export function buildRepositoryUpdateSteps(repoRoot: string): RepositoryUpdateStep[] {
  return [
    {
      label: "拉取远端更新",
      command: "git",
      args: ["pull", "--ff-only"],
      cwd: repoRoot,
    },
    {
      label: "安装依赖",
      command: "bun",
      args: ["install"],
      cwd: repoRoot,
    },
    {
      label: "重新构建 CLI",
      command: "bun",
      args: ["run", "build:cli"],
      cwd: repoRoot,
    },
  ];
}

/**
 * 主更新入口。
 */
export async function updateCommand(): Promise<void> {
  const currentVersion = getVersion();
  const repoRoot = findRepositoryRootFromEntry();

  console.log(`${BOLD}claudish${RESET} ${CYAN}v${currentVersion}${RESET} 私有仓库自动更新\n`);

  if (!repoRoot) {
    console.error(`${RED}更新失败:${RESET} 无法从当前运行入口定位 Git 仓库。`);
    console.error(`${YELLOW}请确认 claudish 是从你的私有仓库构建并运行的。${RESET}\n`);
    process.exit(1);
  }

  const preflight = getRepositoryUpdatePreflight(repoRoot);
  if (!preflight.ok) {
    console.error(`${RED}更新已中止:${RESET} ${preflight.reason}\n`);
    process.exit(1);
  }

  console.log(`${DIM}仓库:${RESET} ${repoRoot}`);
  console.log(`${DIM}上游:${RESET} ${preflight.upstream}\n`);

  for (const step of buildRepositoryUpdateSteps(repoRoot)) {
    console.log(`${CYAN}>${RESET} ${step.label}: ${step.command} ${step.args.join(" ")}`);
    try {
      runUpdateStep(step);
    } catch {
      console.error(`\n${RED}更新失败:${RESET} ${step.label} 未完成。`);
      console.error(`${YELLOW}你可以在仓库中手动运行同一条命令排查问题。${RESET}\n`);
      process.exit(1);
    }
  }

  console.log(`\n${GREEN}更新完成。${RESET} 请重新打开正在运行的 claudish 会话。\n`);
  process.exit(0);
}
