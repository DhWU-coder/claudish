<div align="center">

# Claudish

### 让 Claude Code 使用任意模型

[![npm version](https://img.shields.io/npm/v/claudish.svg?style=flat-square&color=00D4AA)](https://www.npmjs.com/package/claudish)
[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Compatible-d97757?style=flat-square)](https://claude.ai/claude-code)

**用你已有的 AI 订阅和 API Key 跑 Claude Code。** 支持 Anthropic Max、Gemini Advanced、ChatGPT Plus/Codex、Kimi、GLM、OllamaCloud，以及 OpenRouter 上的 580+ 模型和本地模型。

[Website](https://claudish.com) · [Documentation](https://github.com/MadAppGang/claudish/blob/main/docs/index.md) · [Issues](https://github.com/MadAppGang/claudish/issues)

</div>

---

**Claudish** 是一个 CLI 工具。它会在本机启动一个兼容 Anthropic API 的代理服务，让 Claude Code 可以通过这个本地代理访问其他模型或本地推理服务。

## 支持的 Provider

- **云端模型**：OpenRouter、Google Gemini、OpenAI、MiniMax、Kimi、GLM、Z.AI、OllamaCloud、OpenCode Zen、Poe
- **本地模型**：Ollama、LM Studio、vLLM、MLX
- **企业/云平台**：Vertex AI
- **OAuth 模式**：Gemini、Kimi、OpenAI Codex/ChatGPT Plus/Codex 账号

## 典型用法

```bash
# 交互模式：不带 prompt 时默认进入 Claude Code 交互会话
claudish

# 单次任务
claudish --model cx@gpt-5.5 "帮我检查这个项目的安全风险"

# 设置默认模型，以后不用每次写 --model
claudish --default-model cx@gpt-5.5
claudish "给这个模块补测试"
```

## 使用已有订阅

| 订阅/账号 | 示例命令 |
|-----------|----------|
| Anthropic Max | 直接使用 `claude` |
| Gemini Advanced | `claudish --model g@gemini-3-pro-preview` |
| ChatGPT Plus/Codex | `claudish --model cx@gpt-5.5` |
| Kimi | `claudish --model kimi@kimi-k2.5` |
| GLM | `claudish --model glm@GLM-4.7` |
| MiniMax | `claudish --model mm@minimax-m2.1` |
| OllamaCloud | `claudish --model oc@qwen3-next` |
| OpenCode Zen Go | `claudish --model zgo@glm-5` |

完全离线也可以，只要使用本地模型：

```bash
claudish --model ollama@qwen3-coder:latest "你的任务"
```

## 安装

### 快速安装

```bash
# Linux/macOS 安装脚本
curl -fsSL https://raw.githubusercontent.com/MadAppGang/claudish/main/install.sh | bash

# macOS Homebrew
brew tap MadAppGang/tap && brew install claudish

# npm
npm install -g claudish

# Bun
bun install -g claudish
```

### 免安装运行

```bash
npx claudish@latest --model cx@gpt-5.5 "你的任务"
bunx claudish@latest --model cx@gpt-5.5 "你的任务"
```

### 从源码安装

```bash
git clone https://github.com/MadAppGang/claudish.git
cd claudish
bun install
bun run --cwd packages/cli build
bun link
```

## 前置要求

- 已安装 [Claude Code](https://claude.com/claude-code)
- 至少配置一种可用的模型来源：
  - OpenRouter API Key
  - Google Gemini API Key
  - OpenAI API Key
  - Kimi/MiniMax/GLM/OllamaCloud 等 Provider 的 Key
  - 或者本地 Ollama/LM Studio/vLLM/MLX
  - 或者已登录的 OAuth 账号

## 快速开始

### 1. 初始化项目内 Skill

```bash
cd /path/to/your/project
claudish --init
```

这会在当前项目写入 `.claude/skills/claudish-usage/`，用于让 Claude Code 更好地使用 claudish，例如使用文件传递长 prompt、减少上下文污染、按任务选择模型等。

### 2. 登录 OAuth Provider

```bash
# OpenAI Codex / ChatGPT Plus / Codex 账号
claudish login openai-codex

# Gemini
claudish login gemini

# Kimi
claudish login kimi
```

### 3. 设置默认模型

推荐先设置默认模型：

```bash
claudish --default-model cx@gpt-5.5
```

之后可以直接运行：

```bash
claudish
claudish "帮我重构这个模块"
```

默认模型会写入：

```text
~/.claudish/config.json
```

配置格式示例：

```json
{
  "defaultModel": "cx@gpt-5.5"
}
```

默认模型优先级：

```text
--model 参数 > CLAUDISH_MODEL 环境变量 > ~/.claudish/config.json 的 defaultModel > ANTHROPIC_MODEL > 交互选择
```

## 常用命令

```bash
# 查看帮助
claudish --help

# 查看可用模型
claudish --list-models

# 搜索模型
claudish -s gpt
claudish -s gemini

# 查看推荐模型
claudish --top-models

# 指定模型运行
claudish --model cx@gpt-5.5 "实现用户登录"

# 从 stdin 读取长任务
claudish --stdin < task.md

# JSON 输出，方便脚本调用
claudish --json --model cx@gpt-5.5 "只输出 JSON"

# 调试日志
claudish --debug --model cx@gpt-5.5 "复现这个错误"

# 添加 OpenAI/Anthropic/Gemini 兼容 Provider
claudish --set-provider
```

## 模型路由语法

推荐使用新语法：

```text
provider@model[:concurrency]
```

示例：

```bash
claudish --model cx@gpt-5.5 "task"
claudish --model g@gemini-3-pro-preview "task"
claudish --model kimi@kimi-k2.5 "task"
claudish --model mm@minimax-m2.1 "task"
claudish --model glm@GLM-4.7 "task"
claudish --model ollama@llama3.2 "task"
claudish --model ollama@llama3.2:3 "并发 3 个本地请求"
```

常用 Provider 缩写：

| 缩写 | Provider |
|------|----------|
| `cx` | OpenAI Codex / ChatGPT OAuth |
| `g` / `gemini` | Google Gemini |
| `oai` | OpenAI API |
| `or` | OpenRouter |
| `kimi` / `moon` | Kimi / Moonshot |
| `mm` / `mmax` | MiniMax |
| `glm` / `zhipu` | GLM / Zhipu |
| `zai` | Z.AI |
| `oc` | OllamaCloud |
| `zen` | OpenCode Zen |
| `v` / `vertex` | Vertex AI |
| `ollama` | 本地 Ollama |
| `lms` / `lmstudio` | 本地 LM Studio |
| `vllm` | 本地 vLLM |
| `mlx` | 本地 MLX |

## 默认 Provider

没有写 `provider@` 的裸模型名会走默认 Provider。可以这样设置：

```bash
claudish --default-provider openrouter --model minimax-m2.5 "task"
```

也可以使用环境变量：

```bash
export CLAUDISH_DEFAULT_PROVIDER=openrouter
```

优先级：

```text
--default-provider > CLAUDISH_DEFAULT_PROVIDER > config.json 的 defaultProvider > 自动检测
```

显式 `provider@model` 永远优先，不受默认 Provider 影响。

## 配置文件

### 添加兼容 Provider

使用交互式向导：

```bash
claudish --set-provider
```

它会依次填写：

```text
provider-id
provider 兼容类型：openai / anthropic / gemini
base_url
api-key
model-id
```

其中 `model-id` 是这个 Provider 的默认模型。配置完成后：

```bash
# 使用默认模型
claudish --model <provider-id> "task"

# 临时换成别的模型
claudish --model <provider-id>@<model-id> "task"
```

配置会写入 `~/.claudish/config.json` 的 `customEndpoints`。

全局配置文件：

```text
~/.claudish/config.json
```

项目级配置文件：

```text
.claudish.json
```

常见配置项：

```json
{
  "defaultModel": "cx@gpt-5.5",
  "defaultProvider": "openrouter",
  "apiKeys": {
    "OPENROUTER_API_KEY": "sk-..."
  },
  "endpoints": {
    "OPENAI_BASE_URL": "https://api.openai.com/v1"
  },
  "customEndpoints": {
    "corp-openai": {
      "kind": "simple",
      "url": "https://api.example.com/v1",
      "format": "openai",
      "apiKey": "${CORP_OPENAI_KEY}",
      "defaultModel": "gpt-4o"
    }
  }
}
```

不要把真实 Key 提交到 Git。项目级 `.claudish.json` 如果包含敏感信息，应加入 `.gitignore`。

## 环境变量

### API Key

| 变量 | 用途 |
|------|------|
| `OPENROUTER_API_KEY` | OpenRouter |
| `GEMINI_API_KEY` | Google Gemini |
| `OPENAI_API_KEY` | OpenAI API |
| `MINIMAX_API_KEY` | MiniMax |
| `MOONSHOT_API_KEY` / `KIMI_API_KEY` | Kimi / Moonshot |
| `ZHIPU_API_KEY` / `GLM_API_KEY` | GLM / Zhipu |
| `OLLAMA_API_KEY` | OllamaCloud |
| `OPENCODE_API_KEY` | OpenCode Zen |
| `POE_API_KEY` | Poe |
| `VERTEX_API_KEY` | Vertex AI Express |
| `VERTEX_PROJECT` | Vertex AI OAuth 模式 |

### Claudish 设置

| 变量 | 说明 |
|------|------|
| `CLAUDISH_MODEL` | 当前 shell 的默认模型，优先级高于配置文件 |
| `CLAUDISH_PORT` | 指定代理端口 |
| `CLAUDISH_CONTEXT_WINDOW` | 覆盖上下文窗口大小 |
| `CLAUDISH_DEFAULT_PROVIDER` | 裸模型名默认 Provider |
| `CLAUDISH_MODEL_OPUS` | Opus 角色模型 |
| `CLAUDISH_MODEL_SONNET` | Sonnet 角色模型 |
| `CLAUDISH_MODEL_HAIKU` | Haiku 角色模型 |
| `CLAUDISH_MODEL_SUBAGENT` | 子代理模型 |
| `CLAUDISH_SUMMARIZE_TOOLS` | 是否压缩工具描述 |
| `CLAUDISH_DIAG_MODE` | 诊断输出模式：`auto`、`logfile`、`off` |

### 本地模型地址

| 变量 | 默认值 |
|------|--------|
| `OLLAMA_BASE_URL` / `OLLAMA_HOST` | `http://localhost:11434` |
| `LMSTUDIO_BASE_URL` | `http://localhost:1234` |
| `VLLM_BASE_URL` | `http://localhost:8000` |
| `MLX_BASE_URL` | `http://127.0.0.1:8080` |

## Claude Code 参数透传

Claudish 只消费自己的参数，未知参数会继续传给 Claude Code。

```bash
claudish --model cx@gpt-5.5 --agent code-review "review auth"
claudish --model cx@gpt-5.5 --effort high --permission-mode plan "设计 API"
claudish --model cx@gpt-5.5 --allowedTools "Read,Grep" "搜索安全问题"
```

如果要传递以 `-` 开头的值，可以使用 `--` 分隔：

```bash
claudish --model cx@gpt-5.5 -- --system-prompt "-verbose mode" "task"
```

## 输出模式

### 默认安静模式

单次任务默认只输出 Claude Code 的结果，适合脚本和管道：

```bash
claudish --model cx@gpt-5.5 "2 + 2 等于几"
```

### Verbose 模式

```bash
claudish --verbose --model cx@gpt-5.5 "task"
```

会显示代理地址、状态、启动/关闭等日志。

### JSON 模式

```bash
claudish --json --model cx@gpt-5.5 "task"
```

适合脚本读取结果、token 和成本信息。

## Monitor 模式

Monitor 模式会代理真实 Anthropic API，用于调试 Claude Code 和协议行为：

```bash
ANTHROPIC_API_KEY=sk-ant-... claudish --monitor --debug "task"
```

注意：Monitor 模式需要真实 Anthropic API Key，不适用于用其他 Provider 替换模型的普通场景。

## 工作原理

1. 解析 CLI 参数、配置文件和环境变量。
2. 根据模型名解析 Provider 和路由。
3. 在本机启动一个 Anthropic API 兼容代理。
4. 让 Claude Code 连接这个本地代理。
5. 代理把请求转换成目标 Provider 的格式。
6. 流式返回结果给 Claude Code。
7. 会话结束后关闭代理。

## 开发

```bash
# 安装依赖
bun install

# 开发运行
bun run --cwd packages/cli dev -- --model cx@gpt-5.5 "task"

# 构建
bun run --cwd packages/cli build

# 测试
bun test

# 指定测试
bun test packages/cli/src/cli.test.ts
```

## 本地全局运行

源码构建后可以 link 到全局：

```bash
cd packages/cli
bun link
claudish --version
```

也可以直接使用仓库里的 launcher，只要 `packages/cli/dist/index.js` 已经 build 过。

## 常见问题

### `claudish: command not found`

说明命令没有安装到 PATH。可以：

```bash
npm install -g claudish
# 或
bun install -g claudish
# 或在源码目录
bun run --cwd packages/cli build
bun link
```

### `Claude Code CLI is not installed`

需要先安装 Claude Code：

```bash
npm install -g @anthropic-ai/claude-code
```

也可以设置：

```bash
export CLAUDE_PATH=/path/to/claude
```

### `401 Unauthorized`

通常是当前模型对应 Provider 没有可用凭据：

- OAuth 模型：先运行 `claudish login <provider>`
- API Key 模型：检查对应环境变量或 `~/.claudish/config.json`
- OpenAI Codex/ChatGPT OAuth：确认已登录 `claudish login openai-codex`

### `Insufficient balance`

说明请求打到了需要余额的 Provider。检查：

- 当前模型是不是你想用的模型
- `CLAUDISH_MODEL` 是否覆盖了配置文件默认模型
- `~/.claude/settings.json` 是否设置了旧的 `ANTHROPIC_BASE_URL`
- 是否应该改用 OAuth Provider，例如 `cx@gpt-5.5`

### 不想每次选择模型

设置默认模型：

```bash
claudish --default-model cx@gpt-5.5
```

确认配置：

```bash
cat ~/.claudish/config.json
```

### 本地模型没有联网隐私风险吗？

如果使用 `ollama@...`、`lmstudio@...`、`vllm@...`、`mlx@...` 并且本地服务没有再转发请求，代码不会离开本机。云端 Provider 会把请求发送给对应远端服务。

## 许可证

MIT。详见 [LICENSE](LICENSE)。

## 链接

- npm: https://www.npmjs.com/package/claudish
- GitHub: https://github.com/MadAppGang/claudish
- OpenRouter: https://openrouter.ai
- Claude Code: https://claude.com/claude-code
- Documentation: https://github.com/MadAppGang/claudish/blob/main/docs/index.md
