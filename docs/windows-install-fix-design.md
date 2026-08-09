# Windows 源码安装永久修复设计

## 背景

当前仓库在 Windows 原生 PowerShell 中从源码安装时存在两个相互独立的问题：

1. 根目录 `bun install` 会安装所有 workspace 及开发依赖，因此会在 Windows 上拉取仅供 macOS bridge 使用的 `cycletls`，同时拉取 Biome 的 Windows 原生可执行包。Bun 1.3.14 可能在把这些原生包移动到全局缓存时触发 `EPERM (NtSetInformationFile)`。
2. `packages/cli/bin/claudish.cjs` 仅通过 Unix 的 `which` 命令和 `$HOME` 下的 Unix 路径查找 Bun。Windows 上即使 Bun 已安装，链接后的 `claudish` 命令仍可能错误地报告找不到 Bun。

此外，根目录 `postinstall` 无条件输出“安装成功”，会让失败的依赖安装看起来像成功。

## 设计目标

- Windows 用户可以通过仓库提供的一条 PowerShell 命令完成运行时依赖安装、构建和链接。
- Windows 安装不依赖 Bun 全局包缓存，不使用 hardlink/global store，从而绕过当前的缓存重命名问题。
- Windows 默认不安装开发依赖，避免为普通源码安装拉取 Biome 原生包。
- Windows 不安装只服务于 macOS desktop bridge 的 `cycletls`。
- 全局 `claudish` 启动器能在 Windows、macOS 和 Linux 上可靠定位 Bun。
- macOS 现有安装、Homebrew 路径和 macOS bridge 功能保持不变。

## 方案

### 1. macOS bridge 平台约束

在 `packages/macos-bridge/package.json` 中增加标准 npm `os: ["darwin"]` 声明。仓库中的 magmux 平台包已经使用相同的 `os`/`cpu` 机制。

效果：

- macOS：workspace 仍受支持，依赖和构建行为不变。
- Windows/Linux：平台声明明确该 workspace 不受支持；由于 Bun 1.3.14 仍可能解析不兼容 workspace 的依赖，Windows 安装入口还会通过独立暂存清单彻底排除 `cycletls`。

### 2. Windows 专用安装入口

新增 `scripts/install-windows.ps1`，并在根 `package.json` 中暴露 `install:windows` 脚本。

安装脚本将：

- 明确拒绝在非 Windows 平台运行。
- 可选清理仓库内残缺的 `node_modules`，且删除前校验目标必须位于仓库根目录内。
- 在仓库内未列入 `packages/*` workspace 的 `tmp/` 目录，根据 `packages/cli/package.json` 生成独立安装清单，使 Bun 不会解析 macOS bridge。
- 从仓库 `bun.lock` 生成仅含 CLI workspace 的暂存锁文件，先以 `--lockfile-only` 让 Bun 裁剪无关包，再使用 frozen lockfile 正式安装，避免独立安装把版本范围解析到未经项目验证的新版本。
- 使用临时 `bunfig.toml` 关闭全局缓存和 global store，并选择 hoisted linker。
- 使用 `--backend copyfile` 安装，避免 Windows hardlink 路径；暂存安装完整成功后，在同一磁盘卷内原子移动其 `node_modules` 替换仓库依赖。
- 默认使用 `--omit dev`，保留 CLI 所需的 optional platform packages；开发者可显式传入 `-Dev` 安装开发依赖。
- 默认构建 CLI 并执行 `bun link`；CI/诊断可使用 `-SkipBuild` 和 `-SkipLink`。
- 始终删除临时配置文件。

该入口仅在用户主动运行 Windows 安装脚本时生效，不改变 macOS/Linux 的普通 `bun install` 行为。

### 3. 跨平台启动器

重构 `packages/cli/bin/claudish.cjs`：

- 如果当前已由 Bun 执行，直接使用 `process.execPath`。
- Windows 使用 `where.exe bun`；macOS/Linux 继续使用 `which bun`。
- Windows 候选路径包含 `BUN_INSTALL` 和 `%USERPROFILE%\.bun\bin\bun.exe`。
- macOS/Linux 保留 `$HOME/.bun/bin/bun`、`/usr/local/bin/bun`、`/opt/homebrew/bin/bun`。
- 不再拼接 `undefined/.bun/...`。
- 找不到 Bun 时按平台输出对应的官方安装命令。
- 将纯辅助函数导出，并用 Node 内置测试框架覆盖 Windows 与 Unix 分支。

### 4. 安装结果提示

将根 `postinstall` 文案改为“依赖安装脚本已完成”，避免在 Bun 最终报告依赖失败之前输出错误的成功结论。Bun 进程的最终退出码仍是安装是否成功的唯一判断依据。

### 5. 持续集成

新增轻量 Windows 工作流，验证：

- 启动器的平台路径单元测试。
- Windows 安装脚本能够安装运行时依赖并构建 CLI。
- 通过 Node 启动链接入口时能找到 Bun，并成功执行 `--version`。

## macOS 兼容性分析

- macOS bridge 的 `os: ["darwin"]` 明确保留 Darwin，不会排除 Intel 或 Apple Silicon。
- 启动器的非 Windows 分支继续使用 `which`，并保留 Homebrew 的 `/opt/homebrew/bin/bun` 与 `/usr/local/bin/bun`。
- Windows 专用安装配置位于运行时临时文件，只由 PowerShell 脚本加载，不会成为 macOS 的默认 Bun 配置。
- 根目录原有 macOS/Linux 安装命令仍可使用；文档只增加平台分流说明。

## 风险与回退

- Bun 1.3.14 会解析不兼容 workspace 的依赖，且 workspace filter 仍可能保留完整锁文件依赖图；因此 Windows 安装脚本必须在仓库 workspace 之外暂存安装。验证结果必须确认 `cycletls` 未落盘。
- `--omit dev` 不得替换为 `--production`，因为后者可能同时省略 CLI 需要的 optional platform packages。
- 若 Windows 安装脚本失败，它只会留下仓库内生成的依赖目录；源码和全局 Bun 缓存不会被修改。
- 所有改动均可逐文件回退，不涉及数据迁移。
