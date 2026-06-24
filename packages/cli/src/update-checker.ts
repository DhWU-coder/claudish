/**
 * 私有仓库版本的更新检查。
 *
 * 启动时不再访问 npm registry，也不再比较公网 claudish 包版本。
 * 真正的更新只通过 `claudish update` 执行当前 Git 仓库的自动更新流程。
 */

import { existsSync, unlinkSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

const isWindows = platform() === "win32";

function getCacheFilePath(): string {
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(localAppData, "claudish", "update-check.json");
  }

  return join(homedir(), ".cache", "claudish", "update-check.json");
}

/**
 * 清理旧版公网更新检查留下的缓存文件。
 */
export function clearCache(): void {
  try {
    const cachePath = getCacheFilePath();
    if (existsSync(cachePath)) {
      unlinkSync(cachePath);
    }
  } catch {
    const fallbackPath = join(tmpdir(), "claudish-update-check.json");
    try {
      if (existsSync(fallbackPath)) {
        unlinkSync(fallbackPath);
      }
    } catch {
      // 清理缓存失败不影响主流程。
    }
  }
}

/**
 * 语义化版本比较工具，保留给内部代码复用。
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.replace(/^v/, "").split(".").map(Number);
  const parts2 = v2.replace(/^v/, "").split(".").map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

/**
 * 私有仓库版本没有公网 latest 概念。
 */
export async function fetchLatestVersion(): Promise<string | null> {
  return null;
}

/**
 * 启动时保持静默，避免任何公网更新提示。
 */
export async function checkForUpdates(
  _currentVersion: string,
  _options: {
    quiet?: boolean;
  } = {}
): Promise<void> {
  clearCache();
}
