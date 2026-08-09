#!/usr/bin/env node

// 为 Windows 独立安装生成只包含 CLI 的清单和可复用的冻结锁文件。

const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

function parseBunLock(lockPath) {
  const source = readFileSync(lockPath, "utf8");
  const strictJson = source.replace(/,(\s*[}\]])/gu, "$1");
  return JSON.parse(strictJson);
}

function getWindowsOptionalDependencies(cliManifest) {
  const platformPackage = `@opentui/core-win32-${process.arch}`;
  const version = cliManifest.optionalDependencies?.[platformPackage];
  if (!version) {
    throw new Error(`CLI 清单缺少当前架构的 OpenTUI 平台包：${platformPackage}`);
  }

  return { [platformPackage]: version };
}

function main() {
  const [cliManifestPath, sourceLockPath, stagingDirectory, mode] = process.argv.slice(2);
  if (!cliManifestPath || !sourceLockPath || !stagingDirectory) {
    throw new Error(
      "用法：create-windows-staging.cjs <CLI package.json> <bun.lock> <暂存目录> [--dev]",
    );
  }

  const includeDevDependencies = mode === "--dev";
  const cliManifest = JSON.parse(readFileSync(cliManifestPath, "utf8"));
  const optionalDependencies = getWindowsOptionalDependencies(cliManifest);
  const stagingManifest = {
    name: "claudish-windows-install",
    version: "0.0.0",
    private: true,
    dependencies: cliManifest.dependencies,
    optionalDependencies,
    ...(includeDevDependencies
      ? { devDependencies: cliManifest.devDependencies }
      : {}),
  };

  const lock = parseBunLock(sourceLockPath);
  // 暂存目录不是原仓库 workspace，必须移除指向原相对路径的 workspace 包映射。
  for (const [packageName, packageEntry] of Object.entries(lock.packages)) {
    const resolution = Array.isArray(packageEntry) ? packageEntry[0] : null;
    if (typeof resolution === "string" && resolution.includes("@workspace:")) {
      delete lock.packages[packageName];
    }
  }
  lock.workspaces = {
    "": {
      name: stagingManifest.name,
      dependencies: stagingManifest.dependencies,
      optionalDependencies: stagingManifest.optionalDependencies,
      ...(includeDevDependencies
        ? { devDependencies: stagingManifest.devDependencies }
        : {}),
    },
  };

  writeFileSync(
    join(stagingDirectory, "package.json"),
    `${JSON.stringify(stagingManifest, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(stagingDirectory, "bun.lock"),
    `${JSON.stringify(lock, null, 2)}\n`,
    "utf8",
  );
}

main();
