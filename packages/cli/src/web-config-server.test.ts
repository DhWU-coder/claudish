import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./profile-config.js";
import { handleConfigWebRequest, startConfigWebServer } from "./web-config-server.js";

const originalClaudishHome = process.env.CLAUDISH_HOME;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalOpenAiCodexApiKey = process.env.OPENAI_CODEX_API_KEY;
let tempHome: string | undefined;
let tempUsageRoot: string | undefined;

// Narrow API response shape used by provider-table assertions in this file.
interface PublicProviderSummaryJson {
  id: string;
  source?: string;
  credentialSource?: string;
  authMode?: string;
  typeLabel?: string;
  baseUrl?: string;
  defaultModel?: string;
  models?: string[];
  apiKey?: string;
}

beforeEach(() => {
  // The web handler writes through the real config layer, isolated per test.
  tempHome = mkdtempSync(join(tmpdir(), "claudish-web-config-"));
  process.env.CLAUDISH_HOME = join(tempHome, ".claudish");
  process.env.OPENAI_API_KEY = undefined;
  process.env.OPENAI_CODEX_API_KEY = undefined;
});

afterEach(() => {
  // Restore the user's environment so tests never leak config locations.
  if (originalClaudishHome === undefined) process.env.CLAUDISH_HOME = undefined;
  else process.env.CLAUDISH_HOME = originalClaudishHome;

  if (originalOpenAiApiKey === undefined) process.env.OPENAI_API_KEY = undefined;
  else process.env.OPENAI_API_KEY = originalOpenAiApiKey;

  if (originalOpenAiCodexApiKey === undefined) process.env.OPENAI_CODEX_API_KEY = undefined;
  else process.env.OPENAI_CODEX_API_KEY = originalOpenAiCodexApiKey;

  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  }

  if (tempUsageRoot) {
    rmSync(tempUsageRoot, { recursive: true, force: true });
    tempUsageRoot = undefined;
  }
});

function request(path: string, init?: RequestInit): Request {
  // The handler only cares about path, method, and body; localhost keeps URLs valid.
  return new Request(`http://127.0.0.1:1456${path}`, init);
}

describe("web config server", () => {
  test("GET / returns the configuration page", async () => {
    const response = await handleConfigWebRequest(request("/"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Claudish Config");
  });

  test("GET /favicon.ico returns an empty success response", async () => {
    const response = await handleConfigWebRequest(request("/favicon.ico"));

    // Browsers request favicons automatically; a 204 keeps local verification
    // console output free from harmless 404 noise.
    expect(response.status).toBe(204);
  });

  test("GET / renders terminal websocket protocol helpers", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // Terminal traffic uses xterm.js and WebSocket JSON envelopes for input
    // and resize events instead of Claude-style SSE parsing.
    expect(html).toContain("xterm@5.3.0");
    expect(html).toContain("xterm-addon-fit");
    expect(html).toContain("sendTerminalInput");
    expect(html).toContain("sendTerminalResize");
    expect(html).toContain('type: "input"');
    expect(html).toContain('type: "resize"');
    expect(html).not.toContain('buffer.split("\\n\\n")');
  });

  test("GET / renders provider editing as a modal with custom comboboxes", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // Provider edits should not occupy a permanent left-hand form panel.
    expect(html).toContain('id="provider-modal"');
    expect(html).toContain('id="provider-add"');
    expect(html).toContain("Edit Provider");

    // The default model/provider pickers should be controlled by our dark UI,
    // not by the browser's unstyleable datalist popup.
    expect(html).toContain('data-combo="models"');
    expect(html).toContain('data-combo="providers"');
    expect(html).toContain('class="combo-menu"');
    expect(html).not.toContain("<datalist");
    expect(html).not.toContain('list="model-options"');
    expect(html).not.toContain('list="provider-options"');
  });

  test("GET / renders channel overview on the config page instead of the Feishu editor", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();
    const configPanel = html.slice(
      html.indexOf('<section class="panel" id="panel-config">'),
      html.indexOf('<section class="panel" id="panel-providers">')
    );

    // 配置页只做全局配置和频道概览，具体账号编辑放到频道页。
    expect(configPanel).toContain('id="config-channel-summary"');
    expect(configPanel).toContain('data-i18n="config.channels"');
    expect(configPanel).not.toContain('id="feishu-config-form"');
    expect(configPanel).not.toContain('id="feishu-account-list"');
  });

  test("GET / renders provider editor as a wide two-column modal", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // Provider credentials and model management should sit side by side on
    // desktop while keeping the model list independently scrollable.
    expect(html).toContain("width: min(980px, calc(100vw - 44px))");
    expect(html).toContain('class="provider-editor-grid"');
    expect(html).toContain('class="provider-editor-info"');
    expect(html).toContain('class="provider-editor-models"');
    expect(html).toContain("grid-template-columns: minmax(0, 0.95fr) minmax(320px, 1.05fr)");
    expect(html).toContain("max-height: min(420px, calc(100vh - 360px))");
    expect(html).toContain("@media (max-width: 760px)");
  });

  test("GET / renders CSS chevrons and an API key visibility control", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // The dropdown arrow is CSS-only so String.raw/Bun cannot render a visible
    // "\u2304" escape sequence inside the button.
    expect(html).toContain("combo-toggle::before");
    expect(html).not.toContain(">⌄</button>");
    expect(html).not.toContain("\\u2304");

    // Provider edits need an explicit reveal button instead of a permanently
    // visible secret field.
    expect(html).toContain('id="provider-key-toggle"');
    expect(html).toContain('type="password"');
    expect(html).toContain("Show API key");
    expect(html).toContain("SECRET_MASK");
    expect(html).toContain("applyMaskedProviderKey");
    expect(html).toContain("isProviderKeyMasked");
    expect(html).toContain("normalizedProviderPayload");
  });

  test("GET / renders full-width tabs in usage-first order", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // The Web UI should use one wide shell for every tab, with Usage first.
    expect(html).toContain("max-width: none");
    expect(html).not.toContain("max-width: 1180px");
    expect(html.indexOf('data-tab="usage"')).toBeLessThan(html.indexOf('data-tab="config"'));
    expect(html.indexOf('data-tab="config"')).toBeLessThan(html.indexOf('data-tab="providers"'));
    expect(html.indexOf('data-tab="providers"')).toBeLessThan(html.indexOf('data-tab="chat"'));
    expect(html).toContain('<button class="tab active" data-tab="usage"');
    expect(html).toContain('<section class="panel active" id="panel-usage"');
  });

  test("GET / renders provider model list editing controls", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // Providers can expose more than one selectable model, so the modal uses a
    // one-at-a-time model editor instead of a bulk textarea.
    expect(html).toContain('id="provider-model-input"');
    expect(html).toContain('id="provider-model-add"');
    expect(html).toContain('id="provider-model-list"');
    expect(html).toContain('data-i18n="providerModal.models"');
    expect(html).toContain("renderProviderModelList");
    expect(html).toContain("addProviderModel");
    expect(html).toContain("removeProviderModel");
    expect(html).toContain("testProviderModel");
    expect(html).toContain("provider-model-test");
    expect(html).toContain("/api/provider-test");
    expect(html).toContain("collectProviderModels");
    expect(html).toContain('"providers.modelCount"');
    expect(html).toContain('"providerModal.addModel"');
    expect(html).toContain('"providerModal.removeModel"');
    expect(html).toContain('"providerModal.testModel"');
    expect(html).toContain('"providerModal.testSuccess"');
    expect(html).toContain('"providerModal.testFailure"');
    expect(html).toContain('"providerModal.modelsHelp"');
    expect(html).toContain(
      "Add one model at a time. The default model will be saved with the list."
    );
    expect(html).not.toContain("One model per line");
    expect(html).not.toContain('<textarea id="provider-models"');
  });

  test("GET / renders expandable provider model commands with icon copy buttons", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // The configuration summary should let users inspect every model under a
    // provider and copy the exact command without opening the edit modal.
    expect(html).toContain("expandedProviderId");
    expect(html).toContain("toggleProviderModels");
    expect(html).toContain("createProviderModelsDetailRow");
    expect(html).toContain("provider-model-toggle");
    expect(html).toContain("provider-model-detail");
    expect(html).toContain("provider-model-command");
    expect(html).toContain("copy-command-button");
    expect(html).toContain("copyProviderCommand");
    expect(html).toContain("navigator.clipboard.writeText");
    expect(html).toContain("providerModelCommand(provider.id, model)");
    expect(html).toContain('"claudish --model " + providerId + "@" + model');
    expect(html).toContain('"providers.copyCommand"');
    expect(html).toContain('"providers.copiedCommand"');
    expect(html).not.toContain('className = "copy-command-button">Copy');
  });

  test("GET / renders Feishu session details in a right-side chat drawer", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    expect(html).toContain('id="feishu-session-drawer"');
    expect(html).toContain("openFeishuSessionDrawer");
    expect(html).toContain("closeFeishuSessionDrawer");
    expect(html).toContain("createFeishuSessionChatThread");
    expect(html).toContain("createFeishuMessageTurn");
    expect(html).toContain("createFeishuToolCard");
    expect(html).toContain("createFeishuFileAttachmentButton");
    expect(html).toContain("openFeishuLocalFile");
    expect(html).toContain("renderFeishuAssistantText");
    expect(html).toContain("parseFeishuFencedBlocks");
    expect(html).toContain("feishu-session-drawer");
    expect(html).toContain("feishu-chat-thread");
    expect(html).toContain("feishu-fenced-block");
    expect(html).toContain("feishu-file-pill");
    expect(html).toContain("feishu-tool-card");
    expect(html).toContain("/api/open-local-file");
    expect(html).toContain("width: 86vw");
    expect(html).toContain("width: 100vw");
    expect(html).toContain('"channels.sessionRawLog"');
    expect(html).not.toContain("createFeishuSessionDetailRow");
  });

  test("GET / renders OAuth provider modal controls", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // OAuth-backed builtin providers should expose a relogin affordance and
    // mode-switching logic instead of editable endpoint credentials.
    expect(html).toContain('id="provider-login"');
    expect(html).toContain('id="provider-url-field"');
    expect(html).toContain('id="provider-key-field"');
    expect(html).toContain("applyProviderModalMode");
    expect(html).toContain("loginBuiltinProvider");
    expect(html).toContain("Codex-Oauth");
    expect(html).toContain("[hidden]");
    expect(html).toContain("display: none !important");
    expect(html).toContain('"providerModal.relogin"');
    expect(html).toContain('"status.oauthLoginStarted"');
    expect(html).toContain('"status.oauthLoginDone"');
  });

  test("GET / renders theme toggle as a light dark icon button", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // The theme toggle should be a compact icon button whose icon reflects the
    // opposite theme action, not a visible text button.
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('class="theme-icon"');
    expect(html).toContain("updateThemeButton");
    expect(html).toContain("Switch to light theme");
    expect(html).toContain("Switch to dark theme");
    expect(html).not.toContain(">Theme</button>");
  });

  test("GET / renders chat as an embedded claudish terminal", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // The Chat tab now hosts a real claudish terminal over WebSocket instead
    // of manually assembling Claude-compatible chat payloads in the browser.
    expect(html).toContain('class="terminal-shell"');
    expect(html).toContain('id="terminal-start"');
    expect(html).toContain('id="terminal-stop"');
    expect(html).toContain('id="terminal-frame"');
    expect(html).toContain('id="terminal"');
    expect(html).toContain("new Terminal");
    expect(html).toContain("/api/terminal");
    expect(html).not.toContain('class="messages"');
    expect(html).not.toContain('id="chat-form"');
  });

  test("GET / renders channels monitor without removing chat terminal", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    expect(html).toContain('data-tab="channels"');
    expect(html).toContain('id="panel-channels"');
    expect(html).toContain('id="channel-list"');
    expect(html).toContain('id="channel-detail"');
    expect(html).toContain('id="channels-status"');
    expect(html).toContain('id="channel-feishu-detail"');
    expect(html).toContain("loadChannels");
    expect(html).toContain("renderChannelList");
    expect(html).toContain("/api/channels");
    expect(html).toContain('id="feishu-config-form"');
    expect(html).toContain('id="feishu-edit-all"');
    expect(html).toContain('id="feishu-save-all"');
    expect(html).toContain('id="feishu-account-add"');
    expect(html).toContain('id="feishu-account-list"');
    expect(html).toContain("renderFeishuAccountSections");
    expect(html).toContain("setFeishuAccountEditing");
    expect(html).toContain("saveFeishuAccount");
    expect(html).toContain("feishu-account-sessions");
    expect(html).toContain('id="feishu-session-drawer"');
    expect(html).toContain("renderFeishuSessions");
    expect(html).toContain("openFeishuSessionDrawer");
    expect(html).toContain("channel-session-detail-button");
    expect(html).toContain('"channels.sessionMonitor"');
    expect(html).toContain('"channels.sessionDetails"');
    expect(html).toContain('id="terminal-start"');
    expect(html).toContain('id="terminal"');
  });

  test("GET / renders Feishu app secret reveal controls", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    expect(html).toContain("createFeishuSecretInput");
    expect(html).toContain("toggleFeishuSecretVisibility");
    expect(html).toContain("feishu-secret-toggle");
    expect(html).toContain("/api/feishu-config/");
    expect(html).toContain("/secret");
    expect(html).toContain('"feishuConfig.showSecret"');
    expect(html).toContain('"feishuConfig.hideSecret"');
  });

  test("GET / renders mutually exclusive Feishu edit and save controls", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    expect(html).toContain('id="feishu-cancel-all"');
    expect(html).toContain(
      'id="feishu-save-all" type="button" data-i18n="feishuConfig.saveAll" hidden'
    );
    expect(html).toContain('id="feishu-cancel-all" type="button" data-i18n="common.cancel" hidden');
    expect(html).toContain("updateFeishuBulkActions");
    expect(html).toContain("cancelFeishuAccountEdit");
    expect(html).toContain("cancelFeishuAllEdits");
    expect(html).toContain("if (isEditing) {");
    expect(html).toContain("actions.append(cancel, save, remove)");
    expect(html).toContain("actions.append(edit, remove)");
    expect(html).not.toContain("actions.append(edit, save, remove)");
  });

  test("GET / renders Feishu connection test controls", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    expect(html).toContain("testFeishuConnection");
    expect(html).toContain("renderFeishuConnectionTestStatus");
    expect(html).toContain("feishu-connection-test");
    expect(html).toContain("/api/channels/");
    expect(html).toContain("/test");
    expect(html).toContain('"feishuConfig.testConnection"');
    expect(html).toContain('"feishuConfig.testingConnection"');
    expect(html).toContain('"feishuConfig.connectionSuccess"');
    expect(html).toContain('"feishuConfig.connectionFailure"');
  });

  test("GET / renders terminal restart behavior for model changes", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // Starting while a terminal is already connected should close the old
    // socket before opening a new claudish session for the selected model.
    expect(html).toContain('"terminal.restart": "Restart Chat"');
    expect(html).toContain('"terminal.restarting": "Restarting claudish..."');
    expect(html).toContain("restartTerminalSession");
    expect(html).toContain("closeTerminalSocket");
    expect(html).toContain("if (terminalSocket !== socket) return");
  });

  test("GET / renders chat as a viewport-fitted panel", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // The Chat tab should not make the whole document taller than the viewport;
    // only the transcript should scroll when conversations become long.
    expect(html).toContain("body.chat-active");
    expect(html).toContain("overflow: hidden");
    expect(html).toContain("height: calc(100vh - 58px)");
    expect(html).toContain("min-height: 0");
    expect(html).toContain('document.body.classList.toggle("chat-active"');
  });

  test("GET / renders localizable UI copy and language toggle", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // The Web UI language switch is intentionally front-end only and persisted
    // in localStorage, so every visible label needs a data-i18n hook.
    expect(html).toContain('id="language-toggle"');
    expect(html).toContain("const translations");
    expect(html).toContain("applyLanguage");
    expect(html).toContain("toggleLanguage");
    expect(html).toContain('data-i18n="tabs.config"');
    expect(html).toContain('data-i18n="terminal.start"');
    expect(html).toContain('data-i18n="terminal.disconnected"');
    expect(html).toContain('"tabs.chat": "Chat"');
    expect(
      html.includes('"tabs.chat": "聊天"') || html.includes('"tabs.chat": "\\u804A\\u5929"')
    ).toBe(true);
    expect(html).toContain('"terminal.start": "Start Chat"');
    expect(
      html.includes('"terminal.start": "启动聊天"') ||
        html.includes('"terminal.start": "\\u542F\\u52A8\\u804A\\u5929"')
    ).toBe(true);
    expect(html).toContain('localStorage.setItem("claudish-language"');
    expect(html).toContain("navigator.language");
  });

  test("GET / renders provider-scoped model combobox logic", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // Model dropdowns should refresh from modelOptionsByProvider whenever the
    // paired provider field changes.
    expect(html).toContain("modelOptionsByProvider");
    expect(html).toContain("refreshModelCombosForProvider");
    expect(html).toContain("defaultProviderEl.addEventListener");
    expect(html).toContain("chatProviderEl.addEventListener");
  });

  test("GET / renders terminal status display", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // Real claudish terminal sessions surface output in the terminal itself,
    // while the toolbar only tracks connection lifecycle.
    expect(html).toContain('id="terminal-status"');
    expect(html).toContain("renderTerminalStatus");
    expect(html).toContain("terminal.connecting");
    expect(html).toContain("terminal.connected");
    expect(html).not.toContain('id="chat-usage"');
    expect(html).not.toContain("renderChatUsage");
  });

  test("GET / renders usage dashboard tab and client refresh logic", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // Usage is its own read-only dashboard tab fed by the local JSONL API.
    expect(html).toContain('data-tab="usage"');
    expect(html).toContain('id="panel-usage"');
    expect(html).toContain('id="usage-filter"');
    expect(html).toContain('id="usage-summary"');
    expect(html).toContain('id="usage-refresh"');
    expect(html).toContain('id="usage-timeline"');
    expect(html).toContain('id="usage-model-provider"');
    expect(html).toContain("loadUsageDashboard");
    expect(html).toContain("renderUsageDashboard");
    expect(html).toContain("/api/usage");
    expect(html).toContain("buildUsageQuery");
    expect(html).toContain("renderTimelineDistribution");
  });

  test("GET / renders usage dashboard as reference-style stacked sections", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // Project directories are long, so they must live in a full-width section
    // below model distribution instead of a cramped three-column card.
    expect(html).toContain('class="usage-main-grid"');
    expect(html).toContain('class="usage-stacked-grid"');
    expect(html).toContain('id="usage-providers"');
    expect(html).toContain('id="usage-models"');
    expect(html).toContain('id="usage-projects"');
    expect(html).toContain("grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr)");
    expect(html).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(html).toContain(".usage-list,");
    expect(html).toContain("overflow: hidden");
  });

  test("GET / renders provider-colored stacked usage timeline", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // Provider colors must be shared between the timeline segments and the
    // provider distribution legend, so stacked bars are readable at a glance.
    expect(html).toContain("const PROVIDER_COLORS");
    expect(html).toContain("providerColor");
    expect(html).toContain("createTimelineSvg");
    expect(html).toContain("renderTimelineSvgBars");
    expect(html).toContain('className = "usage-timeline-frame"');
    expect(html).toContain('className = "usage-timeline-plot"');
    expect(html).toContain('className = "usage-timeline-y-axis"');
    expect(html).toContain('svg.setAttribute("class", "usage-timeline-svg")');
    expect(html).toContain('createElementNS(SVG_NS, "rect")');
    expect(html).toContain("barWidthPercent");
    expect(html).toContain("segmentHeightPercent");
    expect(html).toContain('segment.setAttribute("fill", providerColor(provider.name))');
    expect(html).toContain('className = "usage-provider-dot"');
    expect(html).toContain("usageTimelineEl.replaceChildren(frame)");
    expect(html).toContain(".usage-timeline-plot");
    expect(html).not.toContain("border-radius: 999px");
    expect(html).not.toContain("width: clamp(18px, 5vw, 34px)");
  });

  test("GET / renders timeline bars against a real chart axis instead of fixed-height rows", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // The timeline should scale each bucket against the max token bucket inside
    // a plot area, with axis labels that make the height difference readable.
    expect(html).toContain("maxTimelineTotal");
    expect(html).toContain("timelineAxisLabel");
    expect(html).toContain("usage-timeline-axis-top");
    expect(html).toContain("usage-timeline-axis-zero");
    expect(html).toContain("usage-timeline-bar-hit");
    expect(html).toContain("Math.max(0.5,");
    expect(html).toContain("Math.min(16,");
    expect(html).not.toContain("min-height: 190px");
    expect(html).not.toContain("usageTimelineEl.style.gridTemplateColumns");
  });

  test("GET / renders usage timeline hover tooltip with provider breakdown", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // Timeline bars need an immediate custom tooltip because native title
    // bubbles are delayed and do not show the provider breakdown clearly.
    expect(html).toContain('id="usage-timeline-tooltip"');
    expect(html).toContain("showTimelineTooltip");
    expect(html).toContain("hideTimelineTooltip");
    expect(html).toContain("timelineTooltipContent");
    expect(html).toContain("positionTimelineTooltip");
    expect(html).toContain('className = "usage-tooltip-provider"');
    expect(html).toContain('hit.addEventListener("pointerenter"');
    expect(html).toContain('hit.addEventListener("focus"');
    expect(html).toContain("hit.tabIndex = 0");
    expect(html).toContain('hit.setAttribute("aria-label"');
  });

  test("GET /api/usage returns the project-local usage dashboard", async () => {
    tempUsageRoot = mkdtempSync(join(tmpdir(), "claudish-web-api-usage-"));
    mkdirSync(join(tempUsageRoot, ".claudish-usage"), { recursive: true });
    writeFileSync(
      join(tempUsageRoot, ".claudish-usage", "usage.jsonl"),
      `${JSON.stringify({
        schema_version: "claudish-usage.project-log.v1",
        timestamp: "2026-06-10T09:10:00.000Z",
        provider: "cx",
        model: "old-model",
        cwd: "/repo/old",
        api_surface: "chatgpt-codex-responses",
        request_id: "old-usage",
        usage: { total: 999, input: 900, cached: 0, output: 99, reasoning: 0 },
      })}\n${JSON.stringify({
        schema_version: "claudish-usage.project-log.v1",
        timestamp: "2026-06-17T09:10:00.000Z",
        provider: "cx",
        model: "gpt-5.5",
        cwd: "/repo/default",
        api_surface: "chatgpt-codex-responses",
        request_id: "req-usage",
        usage: { total: 42, input: 20, cached: 5, output: 22, reasoning: 3 },
      })}\n`
    );

    const response = await handleConfigWebRequest(
      request(
        "/api/usage?preset=recent&recentValue=1天&bucket=day&modelProvider=cx&now=2026-06-17T12%3A00%3A00.000Z"
      ),
      {
        usageProjectRoot: tempUsageRoot,
      }
    );
    const body = await response.json();

    // The HTTP endpoint should expose the same aggregate shape as the service.
    expect(response.status).toBe(200);
    expect(body.totalRequests).toBe(1);
    expect(body.totals.total).toBe(42);
    expect(body.byProvider[0].name).toBe("cx");
    expect(body.byModel[0].name).toBe("cx@gpt-5.5");
    expect(body.timeline[0].key).toBe("2026-06-17");
    expect(body.recent[0].requestId).toBe("req-usage");
  });

  test("GET /api/channels returns channel status", async () => {
    const response = await handleConfigWebRequest(request("/api/channels"), {
      channelStatusProvider: () => ({
        channels: [{ id: "feishu", status: "connected", activeSessions: 1 }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      channels: [{ id: "feishu", status: "connected", activeSessions: 1 }],
    });
  });

  test("POST /api/channels/:id/test returns Feishu connection test result", async () => {
    const response = await handleConfigWebRequest(
      request("/api/channels/feishu%3Awudonghao/test", { method: "POST" }),
      {
        channelConnectionTester: async (channelId) => ({
          ok: channelId === "feishu:wudonghao",
          latencyMs: 23,
          checks: [{ name: "tenant_access_token", ok: true }],
        }),
      }
    );
    const missing = await handleConfigWebRequest(
      request("/api/channels/feishu%3Amissing/test", { method: "POST" }),
      {
        channelConnectionTester: async () => ({
          ok: false,
          error: "Channel not found.",
          checks: [],
        }),
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      latencyMs: 23,
      checks: [{ name: "tenant_access_token", ok: true }],
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      ok: false,
      error: "Channel not found.",
      checks: [],
    });
  });

  test("POST /api/open-local-file opens a saved Feishu file under channel cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "claudish-open-file-"));
    const filePath = join(cwd, "feishu-files", "om_1-file_1-Dockerfile.bge");
    mkdirSync(join(cwd, "feishu-files"), { recursive: true });
    writeFileSync(filePath, "FROM python:3.11");
    let openedPath = "";

    const response = await handleConfigWebRequest(
      request("/api/open-local-file", {
        method: "POST",
        body: JSON.stringify({ path: filePath }),
      }),
      {
        channelStatusProvider: () => ({
          channels: [{ id: "feishu:wudonghao", status: "connected", cwd }],
        }),
        localFileOpener: (path) => {
          openedPath = path;
        },
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(openedPath).toBe(filePath);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("POST /api/open-local-file rejects paths outside Feishu file cache", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "claudish-open-file-"));
    const outsidePath = join(cwd, "other.txt");
    writeFileSync(outsidePath, "nope");
    let opened = false;

    const response = await handleConfigWebRequest(
      request("/api/open-local-file", {
        method: "POST",
        body: JSON.stringify({ path: outsidePath }),
      }),
      {
        channelStatusProvider: () => ({
          channels: [{ id: "feishu:wudonghao", status: "connected", cwd }],
        }),
        localFileOpener: () => {
          opened = true;
        },
      }
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("Feishu file");
    expect(opened).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("GET /api/config includes model options from defaults and custom providers", async () => {
    // The browser model picker needs server-provided options without making
    // external catalog requests during page load.
    saveConfig({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      defaultModel: "cx@gpt-5.5",
      customEndpoints: {
        "corp-openai": {
          kind: "simple",
          url: "https://llm.example.com/v1",
          format: "openai",
          apiKey: "secret",
          defaultModel: "gpt-4o",
          models: ["gpt-4o", "gpt-4.1"],
        },
      },
    });

    const response = await handleConfigWebRequest(request("/api/config"));
    const body = await response.json();

    expect(body.providerOptions).toEqual(["corp-openai"]);
    expect(body.modelOptions).not.toContain("cx@gpt-5.5");
    expect(body.modelOptions).toContain("corp-openai@gpt-4o");
    expect(body.modelOptionsByProvider.cx).toBeUndefined();
    expect(body.modelOptionsByProvider["corp-openai"]).toEqual(["gpt-4o", "gpt-4.1"]);
    expect(body.customProviders[0].models).toEqual(["gpt-4o", "gpt-4.1"]);
  });

  test("GET /api/feishu-config returns masked Feishu accounts from config.yaml", async () => {
    const configPath = join(process.env.CLAUDISH_HOME!, "config.yaml");
    mkdirSync(process.env.CLAUDISH_HOME!, { recursive: true });
    writeFileSync(
      configPath,
      [
        "channels:",
        "  feishu:",
        "    accounts:",
        "      - id: donghao",
        "        enabled: true",
        "        appId: cli_donghao",
        "        appSecret: secret_donghao",
        "        botOpenId: ou_donghao",
        "        domain: lark",
        "        model: cx@gpt-5.5",
        "        cwd: ~/.claudish/workspace/donghao",
        "        sessionMode: headless",
        "        sendProgressReplies: true",
      ].join("\n")
    );

    const response = await handleConfigWebRequest(request("/api/feishu-config"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.accounts).toEqual([
      {
        id: "donghao",
        enabled: true,
        appId: "cli_donghao",
        appSecret: "",
        hasAppSecret: true,
        botOpenId: "ou_donghao",
        domain: "lark",
        sendProgressReplies: true,
        model: "cx@gpt-5.5",
        cwd: "~/.claudish/workspace/donghao",
        sessionMode: "headless",
      },
    ]);
  });

  test("GET /api/feishu-config/:id/secret returns one saved Feishu secret", async () => {
    const configPath = join(process.env.CLAUDISH_HOME!, "config.yaml");
    mkdirSync(process.env.CLAUDISH_HOME!, { recursive: true });
    writeFileSync(
      configPath,
      [
        "channels:",
        "  feishu:",
        "    accounts:",
        "      - id: donghao",
        "        enabled: true",
        "        appId: cli_donghao",
        "        appSecret: secret_donghao",
        "      - id: team",
        "        enabled: true",
        "        appId: cli_team",
        "        appSecret: secret_team",
      ].join("\n")
    );

    const response = await handleConfigWebRequest(request("/api/feishu-config/donghao/secret"));
    const missing = await handleConfigWebRequest(request("/api/feishu-config/missing/secret"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ appSecret: "secret_donghao" });
    expect(missing.status).toBe(404);
  });

  test("POST /api/feishu-config saves accounts and preserves blank existing secrets", async () => {
    const configPath = join(process.env.CLAUDISH_HOME!, "config.yaml");
    mkdirSync(process.env.CLAUDISH_HOME!, { recursive: true });
    writeFileSync(
      configPath,
      [
        "# 这个注释属于 service，保存飞书账号时必须保留。",
        "service:",
        "  port: 17888",
        "# 这个注释属于其他配置，也必须保留。",
        "customSection:",
        "  note: keep-me",
        "channels:",
        "  feishu:",
        "    accounts:",
        "      - id: donghao",
        "        enabled: true",
        "        appId: cli_old",
        "        appSecret: secret_old",
        "        botOpenId: ou_old",
        "        domain: feishu",
        "        model: cx@gpt-5.5",
        "        cwd: ~/.claudish/workspace/donghao",
        "        sessionMode: headless",
        "        sendProgressReplies: false",
      ].join("\n")
    );

    const response = await handleConfigWebRequest(
      request("/api/feishu-config", {
        method: "POST",
        body: JSON.stringify({
          accounts: [
            {
              id: "donghao",
              enabled: false,
              appId: "cli_new",
              appSecret: "",
              botOpenId: "ou_new",
              domain: "lark",
              sendProgressReplies: true,
            },
            {
              id: "team",
              enabled: true,
              appId: "cli_team",
              appSecret: "secret_team",
              botOpenId: "ou_team",
              domain: "feishu",
              sendProgressReplies: false,
            },
          ],
        }),
      })
    );
    const body = await response.json();
    const yaml = readFileSync(configPath, "utf-8");

    expect(response.status).toBe(200);
    expect(body.accounts.map((account: { id: string }) => account.id)).toEqual(["donghao", "team"]);
    expect(yaml).toContain("port: 17888");
    expect(yaml).toContain("# 这个注释属于 service，保存飞书账号时必须保留。");
    expect(yaml).toContain("# 这个注释属于其他配置，也必须保留。");
    expect(yaml).toContain("customSection:");
    expect(yaml).toContain("note: keep-me");
    expect(yaml).toContain("id: donghao");
    expect(yaml).toContain("enabled: false");
    expect(yaml).toContain("appId: cli_new");
    expect(yaml).toContain("appSecret: secret_old");
    expect(yaml).toContain("domain: lark");
    expect(yaml).toContain("sendProgressReplies: true");
    expect(yaml).toContain("id: team");
    expect(yaml).toContain("appSecret: secret_team");
  });

  test("POST /api/feishu-config converts legacy single-account config to accounts", async () => {
    const configPath = join(process.env.CLAUDISH_HOME!, "config.yaml");
    mkdirSync(process.env.CLAUDISH_HOME!, { recursive: true });
    writeFileSync(
      configPath,
      [
        "channels:",
        "  feishu:",
        "    enabled: true",
        "    appId: cli_legacy",
        "    appSecret: secret_legacy",
        "    botOpenId: ou_legacy",
      ].join("\n")
    );

    const response = await handleConfigWebRequest(
      request("/api/feishu-config", {
        method: "POST",
        body: JSON.stringify({
          accounts: [
            {
              id: "default",
              enabled: true,
              appId: "cli_legacy_new",
              appSecret: "",
              botOpenId: "ou_legacy_new",
              domain: "feishu",
              sendProgressReplies: false,
            },
          ],
        }),
      })
    );
    const yaml = readFileSync(configPath, "utf-8");

    expect(response.status).toBe(200);
    expect(yaml).toContain("accounts:");
    expect(yaml).toContain("id: default");
    expect(yaml).toContain("appSecret: secret_legacy");
    expect(yaml).not.toContain("    appId: cli_legacy_new\n    appSecret");
  });

  test("GET /api/config includes configured builtin providers", async () => {
    const oauthPath = join(process.env.CLAUDISH_HOME!, "codex-oauth.json");
    mkdirSync(process.env.CLAUDISH_HOME!, { recursive: true });
    writeFileSync(
      oauthPath,
      JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        expires_at: Date.now() + 60_000,
      })
    );

    const response = await handleConfigWebRequest(request("/api/config"));
    const body = (await response.json()) as { customProviders: PublicProviderSummaryJson[] };
    const codex = body.customProviders.find((provider) => provider.id === "cx");

    // The provider table should include builtin providers once credentials
    // make them real configured options.
    expect(response.status).toBe(200);
    expect(codex).toMatchObject({
      id: "cx",
      source: "builtin",
      credentialSource: "oauth-file",
      authMode: "oauth",
      typeLabel: "Codex-Oauth",
    });
    expect(codex?.baseUrl).toBeUndefined();
    expect(codex?.models).toContain("gpt-5.5");
    expect(codex?.apiKey).toBe("");
    expect(body.providerOptions).toContain("cx");
    expect(body.providerOptions).not.toContain("g");
    expect(body.providerOptions).not.toContain("google");
  });

  test("POST /api/builtin-providers/:id persists builtin model metadata only", async () => {
    const oauthPath = join(process.env.CLAUDISH_HOME!, "codex-oauth.json");
    mkdirSync(process.env.CLAUDISH_HOME!, { recursive: true });
    writeFileSync(
      oauthPath,
      JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        expires_at: Date.now() + 60_000,
      })
    );

    const response = await handleConfigWebRequest(
      request("/api/builtin-providers/cx", {
        method: "POST",
        body: JSON.stringify({
          defaultModel: "gpt-5-codex",
          models: ["gpt-5-codex", "gpt-5.5"],
        }),
      })
    );
    const body = (await response.json()) as { customProviders: PublicProviderSummaryJson[] };
    const codex = body.customProviders.find((provider) => provider.id === "cx");

    // Saving cx model metadata must not create customEndpoints.cx, otherwise
    // the real Codex OAuth transport would be shadowed.
    expect(response.status).toBe(200);
    expect(loadConfig().customEndpoints?.cx).toBeUndefined();
    expect(loadConfig().builtinProviderModels?.cx).toEqual(["gpt-5-codex", "gpt-5.5"]);
    expect(codex?.defaultModel).toBe("gpt-5-codex");
  });

  test("POST /api/builtin-providers/:id refreshes an API-key builtin credential", async () => {
    saveConfig({
      ...loadConfig(),
      apiKeys: { OPENROUTER_API_KEY: "old-openrouter-key" },
    });

    const response = await handleConfigWebRequest(
      request("/api/builtin-providers/or", {
        method: "POST",
        body: JSON.stringify({
          apiKey: "new-openrouter-key",
          defaultModel: "openai/gpt-5",
          models: ["openai/gpt-5", "anthropic/claude-sonnet-4"],
        }),
      })
    );
    const body = (await response.json()) as { customProviders: PublicProviderSummaryJson[] };
    const openrouter = body.customProviders.find((provider) => provider.id === "or");

    // Builtin API-key edits should refresh ~/.claudish/config.json apiKeys
    // without creating a same-id custom endpoint shadow.
    expect(response.status).toBe(200);
    expect(loadConfig().customEndpoints?.or).toBeUndefined();
    expect(loadConfig().apiKeys?.OPENROUTER_API_KEY).toBe("new-openrouter-key");
    expect(openrouter?.defaultModel).toBe("openai/gpt-5");
  });

  test("POST /api/oauth-login/:id triggers the configured login handler", async () => {
    const calls: string[] = [];
    const response = await handleConfigWebRequest(
      request("/api/oauth-login/cx", { method: "POST" }),
      {
        oauthLogin: async (providerId) => {
          calls.push(providerId);
        },
      }
    );
    const body = (await response.json()) as { ok: boolean };

    // The Web UI delegates browser-based OAuth login to a server-side handler
    // so tests never need to open the real OpenAI auth page.
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(calls).toEqual(["cx"]);
  });

  test("POST /api/defaults persists default model and provider", async () => {
    const response = await handleConfigWebRequest(
      request("/api/defaults", {
        method: "POST",
        body: JSON.stringify({
          defaultModel: "gpt-5.5",
          defaultProvider: "openrouter",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(loadConfig().defaultModel).toBe("gpt-5.5");
    expect(loadConfig().defaultProvider).toBe("openrouter");
  });

  test("POST /api/defaults splits provider model specs into default fields", async () => {
    const response = await handleConfigWebRequest(
      request("/api/defaults", {
        method: "POST",
        body: JSON.stringify({
          defaultModel: "cx@gpt-5.5",
          defaultProvider: "openrouter",
        }),
      })
    );

    // Choosing cx@gpt-5.5 means provider cx and bare model gpt-5.5.
    expect(response.status).toBe(200);
    expect(loadConfig().defaultProvider).toBe("cx");
    expect(loadConfig().defaultModel).toBe("gpt-5.5");
  });

  test("POST /api/custom-providers creates a simple custom provider", async () => {
    const response = await handleConfigWebRequest(
      request("/api/custom-providers", {
        method: "POST",
        body: JSON.stringify({
          providerId: "corp-openai",
          format: "openai",
          baseUrl: "https://llm.example.com/v1/",
          apiKey: "${CORP_OPENAI_KEY}",
          defaultModel: "gpt-4o",
          models: "gpt-4o\ngpt-4.1\n",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(loadConfig().customEndpoints?.["corp-openai"]).toEqual({
      kind: "simple",
      url: "https://llm.example.com/v1",
      format: "openai",
      apiKey: "${CORP_OPENAI_KEY}",
      defaultModel: "gpt-4o",
      models: ["gpt-4o", "gpt-4.1"],
    });
  });

  test("POST /api/custom-providers preserves an existing key when editing without a new key", async () => {
    // Editing rows from the provider table should not require retyping the
    // existing secret every time.
    await handleConfigWebRequest(
      request("/api/custom-providers", {
        method: "POST",
        body: JSON.stringify({
          providerId: "corp-openai",
          format: "openai",
          baseUrl: "https://old.example.com/v1",
          apiKey: "sk-existing",
          defaultModel: "gpt-4o",
        }),
      })
    );

    const response = await handleConfigWebRequest(
      request("/api/custom-providers", {
        method: "POST",
        body: JSON.stringify({
          providerId: "corp-openai",
          format: "anthropic",
          baseUrl: "https://new.example.com/v1",
          apiKey: "",
          defaultModel: "claude-opus-4-7",
          models: "claude-opus-4-7\nclaude-sonnet-4-7",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(loadConfig().customEndpoints?.["corp-openai"]).toEqual({
      kind: "simple",
      url: "https://new.example.com/v1",
      format: "anthropic",
      apiKey: "sk-existing",
      defaultModel: "claude-opus-4-7",
      models: ["claude-opus-4-7", "claude-sonnet-4-7"],
    });
  });

  test("GET /api/custom-providers/:id/secret returns the saved key for local reveal", async () => {
    await handleConfigWebRequest(
      request("/api/custom-providers", {
        method: "POST",
        body: JSON.stringify({
          providerId: "corp-openai",
          format: "openai",
          baseUrl: "https://llm.example.com/v1",
          apiKey: "sk-existing",
          defaultModel: "gpt-4o",
        }),
      })
    );

    const response = await handleConfigWebRequest(
      request("/api/custom-providers/corp-openai/secret")
    );
    const body = await response.json();

    // The normal config API remains masked; this endpoint is only for the
    // explicit eye-button reveal action on localhost.
    expect(response.status).toBe(200);
    expect(body.apiKey).toBe("sk-existing");
  });

  test("DELETE /api/custom-providers/:id removes a custom provider", async () => {
    await handleConfigWebRequest(
      request("/api/custom-providers", {
        method: "POST",
        body: JSON.stringify({
          providerId: "corp-openai",
          format: "openai",
          baseUrl: "https://llm.example.com/v1",
          apiKey: "secret",
          defaultModel: "gpt-4o",
        }),
      })
    );

    const response = await handleConfigWebRequest(
      request("/api/custom-providers/corp-openai", { method: "DELETE" })
    );

    expect(response.status).toBe(200);
    expect(loadConfig().customEndpoints?.["corp-openai"]).toBeUndefined();
  });

  test("DELETE /api/custom-providers/:id clears builtin OAuth credentials", async () => {
    const oauthPath = join(process.env.CLAUDISH_HOME!, "codex-oauth.json");
    mkdirSync(process.env.CLAUDISH_HOME!, { recursive: true });
    writeFileSync(
      oauthPath,
      JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        expires_at: Date.now() + 60_000,
      })
    );

    const response = await handleConfigWebRequest(
      request("/api/custom-providers/cx", { method: "DELETE" })
    );
    const body = (await response.json()) as {
      deleted: boolean;
      state: { customProviders: PublicProviderSummaryJson[] };
    };

    // Builtin delete is credential cleanup: after removing the OAuth cache,
    // the builtin provider no longer appears as configured.
    expect(response.status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(existsSync(oauthPath)).toBe(false);
    expect(body.state.customProviders.some((provider) => provider.id === "cx")).toBe(false);
  });

  test("DELETE /api/custom-providers/:id reports env-backed builtin credentials", async () => {
    process.env.OPENAI_CODEX_API_KEY = "sk-env";

    const response = await handleConfigWebRequest(
      request("/api/custom-providers/cx", { method: "DELETE" })
    );
    const body = await response.json();

    // Environment variables are outside the config file, so the Web UI should
    // tell the user what to unset instead of pretending deletion worked.
    expect(response.status).toBe(400);
    expect(body.error).toContain("OPENAI_CODEX_API_KEY");
  });

  test("POST /api/chat returns not found after legacy chat endpoint removal", async () => {
    // Web Chat 现在由 /api/terminal 驱动真实 claudish 会话，旧的纯代理聊天接口不再暴露。
    const response = await handleConfigWebRequest(
      request("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          provider: "openrouter",
          model: "openrouter@anthropic/claude-sonnet-4",
          messages: [{ role: "user", content: "hello" }],
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Not found");
  });

  test("POST /api/provider-test probes through claudish CLI with provider-prefixed model", async () => {
    let capturedProvider = "";
    let capturedModel = "";
    let capturedModelSpec = "";
    let capturedPrompt = "";
    let capturedProviderConfig: unknown;
    const response = await handleConfigWebRequest(
      request("/api/provider-test", {
        method: "POST",
        body: JSON.stringify({
          provider: "tokenhub",
          model: "claude-opus-4-7-thinking",
          providerConfig: {
            providerId: "tokenhub",
            format: "openai",
            baseUrl: "https://tokenhub.example.com/v1",
            apiKey: "sk-test",
            defaultModel: "claude-opus-4-7-thinking",
            models: ["claude-opus-4-7-thinking"],
          },
        }),
      }),
      {
        // The test runner stands in for the real claudish child process.
        providerProbeRunner: async (input) => {
          capturedProvider = input.provider;
          capturedModel = input.model;
          capturedModelSpec = input.modelSpec;
          capturedPrompt = input.prompt;
          capturedProviderConfig = input.providerConfig;
          return { ok: true, latencyMs: 12, preview: "hi" };
        },
      }
    );
    const body = await response.json();

    // The connectivity test must exercise the same CLI model spec as the
    // terminal chat while keeping the prompt intentionally tiny.
    expect(response.status).toBe(200);
    expect(capturedProvider).toBe("tokenhub");
    expect(capturedModel).toBe("claude-opus-4-7-thinking");
    expect(capturedModelSpec).toBe("tokenhub@claude-opus-4-7-thinking");
    expect(capturedPrompt).toBe("回我hi");
    expect(capturedProviderConfig).toEqual({
      providerId: "tokenhub",
      format: "openai",
      baseUrl: "https://tokenhub.example.com/v1",
      apiKey: "sk-test",
      defaultModel: "claude-opus-4-7-thinking",
      models: ["claude-opus-4-7-thinking"],
    });
    expect(body.ok).toBe(true);
    expect(body.preview).toContain("hi");
    expect(body.latencyMs).toBe(12);
  });

  test("POST /api/provider-test returns CLI probe failures", async () => {
    const response = await handleConfigWebRequest(
      request("/api/provider-test", {
        method: "POST",
        body: JSON.stringify({
          provider: "tokenhub",
          model: "broken-model",
        }),
      }),
      {
        // A failing runner mirrors a claudish single-shot process that exits
        // non-zero or times out.
        providerProbeRunner: async () => ({
          ok: false,
          latencyMs: 30,
          error: "model failed",
        }),
      }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("model failed");
    expect(body.latencyMs).toBe(30);
  });

  test("startConfigWebServer opens the local Web UI when requested", () => {
    let openedUrl = "";
    const server = startConfigWebServer({
      openBrowser: true,
      browserOpener: (url) => {
        // Capturing the URL avoids launching a real browser in tests while
        // proving the server uses the actual bound localhost port.
        openedUrl = url;
      },
    });

    try {
      expect(openedUrl).toBe(`http://127.0.0.1:${server.port}/`);
    } finally {
      server.stop(true);
    }
  });

  test("startConfigWebServer keeps serving when browser opening fails", async () => {
    const originalWarn = console.warn;
    console.warn = () => {
      // Expected opener failures are asserted by keeping the server alive.
    };

    try {
      const server = startConfigWebServer({
        openBrowser: true,
        browserOpener: () => {
          // Browser opening is convenience only; failure must not kill the UI.
          throw new Error("browser unavailable");
        },
      });

      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/favicon.ico`);

        expect(response.status).toBe(204);
      } finally {
        server.stop(true);
      }
    } finally {
      console.warn = originalWarn;
    }
  });

  test("terminal websocket starts claudish in the configured project directory", async () => {
    const terminalCwd = mkdtempSync(join(tmpdir(), "claudish-terminal-cwd-"));
    let capturedCwd: string | undefined;
    const server = startConfigWebServer({
      terminalWorkingDirectory: terminalCwd,
      terminalSessionFactory: (options) => {
        // Capturing cwd here proves the WebSocket launch path does not fall
        // back to whichever business project launched the config UI.
        capturedCwd = options.cwd;
        options.onData("ready");
        return {
          pid: 123,
          write() {},
          resize() {},
          kill() {},
        };
      },
    });

    try {
      await new Promise<void>((resolve, reject) => {
        // A real browser connects over WebSocket, so the test exercises the
        // same terminal startup path as the UI.
        const socket = new WebSocket(
          `ws://127.0.0.1:${server.port}/api/terminal?provider=cx&model=gpt-5.5`
        );
        socket.addEventListener("message", () => {
          socket.close();
          resolve();
        });
        socket.addEventListener("error", () => reject(new Error("terminal websocket failed")));
      });

      expect(capturedCwd).toBe(terminalCwd);
    } finally {
      server.stop(true);
      rmSync(terminalCwd, { recursive: true, force: true });
    }
  });
});
