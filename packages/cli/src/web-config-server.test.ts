import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./profile-config.js";
import { handleConfigWebRequest } from "./web-config-server.js";

const originalClaudishHome = process.env.CLAUDISH_HOME;
let tempHome: string | undefined;

beforeEach(() => {
  // The web handler writes through the real config layer, isolated per test.
  tempHome = mkdtempSync(join(tmpdir(), "claudish-web-config-"));
  process.env.CLAUDISH_HOME = join(tempHome, ".claudish");
});

afterEach(() => {
  // Restore the user's environment so tests never leak config locations.
  if (originalClaudishHome === undefined) process.env.CLAUDISH_HOME = undefined;
  else process.env.CLAUDISH_HOME = originalClaudishHome;

  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
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

  test("GET / renders chat stream parsing with real newline delimiters", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // String.raw keeps backslashes, so the browser source must use single
    // escaped newlines rather than literal backslash-n delimiters.
    expect(html).toContain('buffer.split("\\n\\n")');
    expect(html).toContain('eventText.split("\\n")');
    expect(html).not.toContain('buffer.split("\\\\n\\\\n")');
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

  test("GET / renders a compact chat app layout", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // Chat should behave like a real chat surface: a compact toolbar above the
    // transcript, an empty state, and a sticky composer instead of a huge left
    // settings card beside an empty box.
    expect(html).toContain('class="chat-shell"');
    expect(html).toContain('class="chat-toolbar"');
    expect(html).toContain('class="chat-meta"');
    expect(html).toContain('class="chat-empty"');
    expect(html).toContain('class="composer-row"');
    expect(html).toContain('data-i18n="chat.emptyTitle"');
    expect(html).not.toContain("<h2>Chat Settings</h2>");
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
    expect(html).toContain('data-i18n="chat.send"');
    expect(html).toContain('data-i18n="chat.usage.none"');
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

  test("GET / renders chat usage status parsing and display", async () => {
    const response = await handleConfigWebRequest(request("/"));
    const html = await response.text();

    // The chat surface should show real provider usage when the stream includes
    // message_delta.usage, without requiring a page refresh or usage-log import.
    expect(html).toContain('id="chat-usage"');
    expect(html).toContain("extractUsageDelta");
    expect(html).toContain("renderChatUsage");
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
        },
      },
    });

    const response = await handleConfigWebRequest(request("/api/config"));
    const body = await response.json();

    expect(body.modelOptions).toContain("cx@gpt-5.5");
    expect(body.modelOptions).toContain("corp-openai@gpt-4o");
    expect(body.modelOptionsByProvider.cx).toContain("gpt-5.5");
    expect(body.modelOptionsByProvider["corp-openai"]).toEqual(["gpt-4o"]);
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

  test("POST /api/chat streams through the injected chat service", async () => {
    // The Web UI endpoint is transport-agnostic here; the real service is
    // covered separately and this test pins the HTTP contract.
    const response = await handleConfigWebRequest(
      request("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          provider: "openrouter",
          model: "openrouter@anthropic/claude-sonnet-4",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      {
        chatService: {
          streamChat: () => new Response("data: hello\n\ndata: [DONE]\n\n"),
        },
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("hello");
  });
});
