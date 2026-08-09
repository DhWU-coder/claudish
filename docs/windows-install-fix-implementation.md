# Windows 源码安装修复实施方案

## 实施步骤

1. 为 `@claudish/macos-bridge` 增加 `os: ["darwin"]`，保持 macOS 支持并阻止非 Darwin 平台安装 bridge 依赖。
2. 新增 `scripts/install-windows.ps1`：
   - 参数：`-Clean`、`-Dev`、`-SkipBuild`、`-SkipLink`。
   - 校验 Windows、Bun 命令和仓库根目录。
   - 在 `-Clean` 时只删除根、CLI、macOS bridge 三个已验证的 `node_modules` 路径。
   - 在仓库的 `tmp/` 非 workspace 目录生成仅包含 CLI 依赖的独立清单和 Bun 配置。
   - 将仓库锁文件转换为仅包含 CLI 根 workspace 的暂存锁文件，由 Bun 以 lockfile-only 模式裁剪后，再启用 frozen lockfile。
   - 关闭缓存/global store，使用 hoisted linker 和 copyfile backend；默认省略开发依赖。
   - 暂存安装成功后再替换仓库的依赖目录，阻止 macOS bridge 依赖被提升安装。
   - 按参数执行构建与链接，并在 finally 中清理临时配置。
3. 在根 `package.json` 增加 `install:windows` 命令。
4. 重构 `packages/cli/bin/claudish.cjs` 的 Bun 定位逻辑并导出可测试辅助函数。
5. 新增 `packages/cli/scripts/claudish-launcher.test.cjs`，覆盖 Windows、macOS/Linux 候选路径、定位器输出和安装提示。
6. 修正 `scripts/postinstall.cjs` 的误导性成功文案。
7. 更新 `README.md`、`README_zh.md` 和安装故障文档，明确 Windows 与 macOS/Linux 的不同安装命令。
8. 新增 Windows CI 工作流，持续验证安装、构建和启动。

## 验证清单

- `node --test packages/cli/scripts/claudish-launcher.test.cjs`
- `node --check packages/cli/bin/claudish.cjs`
- PowerShell 语法解析 `scripts/install-windows.ps1`
- `bun run install:windows -- -Clean -SkipBuild -SkipLink` 完成且不出现 `cycletls`/Biome 安装失败
- `node packages/cli/bin/claudish.cjs --version` 在 Windows 成功找到 Bun
- `bun install --dry-run`/manifest 检查确认 macOS bridge 仍声明 Darwin 支持
- `git diff --check`

## 不在本次范围

- 升级 Biome、CycleTLS 或 Bun 版本。
- 修改 macOS bridge 的业务逻辑。
- 改变发布产物版本号。
- Git 暂存、提交、推送或创建分支。
