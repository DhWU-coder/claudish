/** @jsxImportSource @opentui/react */
/**
 * Defaults and custom-provider panel for the config TUI.
 *
 * This file is deliberately separate from App.tsx so the main keyboard router
 * does not also own all rendering details for the defaults workflow.
 */

import type {
  ConfigEditorState,
  CustomProviderFormat,
  CustomProviderSummary,
} from "../config-editor.js";
import type { ClaudishProfileConfig } from "../profile-config.js";
import { maskKey } from "./providers.js";
import { C } from "./theme.js";

export interface CustomProviderDraft {
  providerId: string;
  format: CustomProviderFormat;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

interface DefaultsContentProps {
  active: boolean;
  contentH: number;
  customProviderDraft: CustomProviderDraft;
  customProviderIndex: number;
  customProviders: CustomProviderSummary[];
  editorState: ConfigEditorState;
  inputValue: string;
  isDefaultsEditMode: boolean;
  mode: string;
  setInputValue: (value: string) => void;
  width: number;
  config: ClaudishProfileConfig;
}

interface DefaultsDetailProps {
  customProviderIndex: number;
  customProviders: CustomProviderSummary[];
  detailH: number;
}

/**
 * Render the main Defaults tab content area.
 */
export function DefaultsContent(props: DefaultsContentProps) {
  if (props.mode === "edit_default_model") {
    return (
      <DefaultsTextInput
        contentH={props.contentH}
        hint="Examples: cx@gpt-5.5, g@gemini-3-pro-preview, openrouter@anthropic/claude-sonnet-4"
        label="Default model"
        setInputValue={props.setInputValue}
        value={props.inputValue}
        width={props.width}
      />
    );
  }

  if (props.mode === "edit_default_provider") {
    return (
      <DefaultsTextInput
        contentH={props.contentH}
        hint="Use a builtin provider name such as openrouter, google, openai, litellm, or a custom provider id."
        label="Default provider"
        setInputValue={props.setInputValue}
        value={props.inputValue}
        width={props.width}
      />
    );
  }

  if (props.isDefaultsEditMode) {
    return <CustomProviderWizard {...props} />;
  }

  return <DefaultsOverview {...props} />;
}

/**
 * Render the detail panel under the Defaults tab.
 */
export function DefaultsDetail({
  customProviderIndex,
  customProviders,
  detailH,
}: DefaultsDetailProps) {
  const selectedProvider = customProviders[customProviderIndex];

  return (
    <box
      height={detailH}
      border
      borderStyle="single"
      borderColor={C.dim}
      title={selectedProvider ? ` ${selectedProvider.id} ` : " Defaults "}
      backgroundColor={C.bgAlt}
      flexDirection="column"
      paddingX={1}
    >
      {selectedProvider ? (
        <SelectedProviderDetail provider={selectedProvider} />
      ) : (
        <DefaultsHelpDetail />
      )}
    </box>
  );
}

/**
 * Render a focused text input used for default model/provider edits.
 */
function DefaultsTextInput({
  contentH,
  hint,
  label,
  setInputValue,
  value,
  width,
}: {
  contentH: number;
  hint: string;
  label: string;
  setInputValue: (value: string) => void;
  value: string;
  width: number;
}) {
  return (
    <box
      height={contentH}
      border
      borderStyle="single"
      borderColor={C.focusBorder}
      backgroundColor={C.bg}
      flexDirection="column"
      paddingX={1}
    >
      <text>
        <span fg={C.blue} bold>
          {label}
        </span>
      </text>
      <box flexDirection="row">
        <text>
          <span fg={C.green} bold>
            {"> "}
          </span>
        </text>
        <input
          value={value}
          onChange={setInputValue}
          focused={true}
          width={width - 8}
          backgroundColor={C.bgHighlight}
          textColor={C.white}
        />
      </box>
      <text>
        <span fg={C.dim}>{hint}</span>
      </text>
      <text>
        <span fg={C.green} bold>
          Enter{" "}
        </span>
        <span fg={C.fgMuted}>save · </span>
        <span fg={C.red} bold>
          Esc{" "}
        </span>
        <span fg={C.fgMuted}>cancel</span>
      </text>
    </box>
  );
}

/**
 * Render the custom provider setup wizard.
 */
function CustomProviderWizard(props: DefaultsContentProps) {
  const label = getWizardLabel(props.mode);

  return (
    <box
      height={props.contentH}
      border
      borderStyle="single"
      borderColor={C.focusBorder}
      backgroundColor={C.bg}
      flexDirection="column"
      paddingX={1}
    >
      <text>
        <span fg={C.blue} bold>
          {"Custom provider setup"}
        </span>
        <span fg={C.dim}>{"  "}</span>
        <span fg={C.fgMuted}>{label}</span>
      </text>
      <text>
        <span fg={C.dim}>{"Provider: "}</span>
        <span fg={C.cyan}>{props.customProviderDraft.providerId || "(new)"}</span>
        <span fg={C.dim}>{"  Format: "}</span>
        <span fg={C.yellow}>{props.customProviderDraft.format}</span>
      </text>
      <text> </text>
      {props.mode === "custom_provider_format" ? (
        <ProviderFormatPicker />
      ) : (
        <ProviderWizardInput mode={props.mode} draft={props.customProviderDraft} />
      )}
    </box>
  );
}

/**
 * Render the one-key provider format picker.
 */
function ProviderFormatPicker() {
  return (
    <box flexDirection="column">
      <text>
        <span fg={C.green} bold>
          o{" "}
        </span>
        <span fg={C.fgMuted}>openai-compatible</span>
      </text>
      <text>
        <span fg={C.green} bold>
          a{" "}
        </span>
        <span fg={C.fgMuted}>anthropic-compatible</span>
      </text>
      <text>
        <span fg={C.green} bold>
          g{" "}
        </span>
        <span fg={C.fgMuted}>gemini-compatible</span>
      </text>
      <text> </text>
      <text>
        <span fg={C.red} bold>
          Esc{" "}
        </span>
        <span fg={C.fgMuted}>back</span>
      </text>
    </box>
  );
}

/**
 * Render the current text field in the custom provider wizard.
 */
function ProviderWizardInput({
  draft,
  mode,
}: {
  draft: CustomProviderDraft;
  mode: string;
}) {
  const current = getWizardValue(mode, draft);
  return (
    <box flexDirection="column">
      <text>
        <span fg={C.green} bold>
          {"> "}
        </span>
        <span fg={mode === "custom_provider_key" ? C.yellow : C.white}>
          {mode === "custom_provider_key" ? maskKey(current) : current}
        </span>
        <span fg={C.cyan}>{"█"}</span>
      </text>
      <text>
        <span fg={C.dim}>
          {mode === "custom_provider_model"
            ? "Leave empty to require provider@model explicitly."
            : "Enter to continue."}
        </span>
      </text>
      <text>
        <span fg={C.green} bold>
          Enter{" "}
        </span>
        <span fg={C.fgMuted}>continue/save · </span>
        <span fg={C.red} bold>
          Esc{" "}
        </span>
        <span fg={C.fgMuted}>cancel</span>
      </text>
    </box>
  );
}

/**
 * Render the read-only overview for defaults and custom providers.
 */
function DefaultsOverview(props: DefaultsContentProps) {
  const listH = Math.max(3, props.contentH - 8);
  return (
    <box
      height={props.contentH}
      border
      borderStyle="single"
      borderColor={props.active ? C.blue : C.dim}
      backgroundColor={C.bg}
      flexDirection="column"
      paddingX={1}
    >
      <DefaultsSummary config={props.config} editorState={props.editorState} />
      <text>
        <span fg={C.dim}>{" ─".repeat(Math.max(1, Math.floor((props.width - 6) / 2)))}</span>
      </text>
      <text>
        <span fg={C.blue} bold>
          {"Custom providers"}
        </span>
        <span fg={C.fgMuted}>{"  (saved under customEndpoints)"}</span>
      </text>
      <CustomProvidersTable
        customProviderIndex={props.customProviderIndex}
        customProviders={props.customProviders}
        listH={listH}
      />
    </box>
  );
}

/**
 * Render current and effective default settings.
 */
function DefaultsSummary({
  config,
  editorState,
}: {
  config: ClaudishProfileConfig;
  editorState: ConfigEditorState;
}) {
  return (
    <>
      <text>
        <span fg={C.blue} bold>
          {"Default model:    "}
        </span>
        <span fg={config.defaultModel ? C.cyan : C.dim}>{config.defaultModel || "(not set)"}</span>
        <span fg={C.dim}>{"  effective: "}</span>
        <span fg={editorState.effectiveDefaultModel.value ? C.white : C.dim}>
          {editorState.effectiveDefaultModel.value || "(interactive selector)"}
        </span>
        <span fg={C.dim}>{` (${editorState.effectiveDefaultModel.source})`}</span>
      </text>
      <text>
        <span fg={C.blue} bold>
          {"Default provider: "}
        </span>
        <span fg={config.defaultProvider ? C.cyan : C.dim}>
          {config.defaultProvider || "(not set)"}
        </span>
        <span fg={C.dim}>{"  effective: "}</span>
        <span fg={C.white}>{editorState.effectiveDefaultProvider.value}</span>
        <span fg={C.dim}>{` (${editorState.effectiveDefaultProvider.source})`}</span>
      </text>
    </>
  );
}

/**
 * Render custom provider rows.
 */
function CustomProvidersTable({
  customProviderIndex,
  customProviders,
  listH,
}: {
  customProviderIndex: number;
  customProviders: CustomProviderSummary[];
  listH: number;
}) {
  if (customProviders.length === 0) {
    return (
      <text>
        <span fg={C.fgMuted}>{" None configured. Press "}</span>
        <span fg={C.green} bold>
          n
        </span>
        <span fg={C.fgMuted}>{" to add one."}</span>
      </text>
    );
  }

  return (
    <>
      <text>
        <span fg={C.blue} bold>
          {"ID               "}
        </span>
        <span fg={C.blue} bold>
          {"TYPE       "}
        </span>
        <span fg={C.blue} bold>
          {"DEFAULT MODEL"}
        </span>
      </text>
      {customProviders.slice(0, listH).map((provider, idx) => (
        <CustomProviderRow
          key={provider.id}
          provider={provider}
          selected={idx === customProviderIndex}
        />
      ))}
    </>
  );
}

/**
 * Render one custom provider row.
 */
function CustomProviderRow({
  provider,
  selected,
}: {
  provider: CustomProviderSummary;
  selected: boolean;
}) {
  const typeText = getProviderTypeText(provider);
  return (
    <box height={1} flexDirection="row" backgroundColor={selected ? C.bgHighlight : C.bg}>
      <text>
        <span fg={selected ? C.white : C.fgMuted} bold={selected}>
          {provider.id.padEnd(17).substring(0, 17)}
        </span>
        <span fg={C.dim}>{"  "}</span>
        <span fg={provider.kind === "invalid" ? C.red : C.cyan}>
          {typeText.padEnd(10).substring(0, 10)}
        </span>
        <span fg={C.dim}>{"  "}</span>
        <span fg={provider.defaultModel ? C.fgMuted : C.dim}>
          {provider.defaultModel || "(none)"}
        </span>
      </text>
    </box>
  );
}

/**
 * Render selected provider metadata in the lower detail panel.
 */
function SelectedProviderDetail({ provider }: { provider: CustomProviderSummary }) {
  return (
    <>
      <text>
        <span fg={C.blue} bold>
          {"URL:   "}
        </span>
        <span fg={provider.baseUrl ? C.cyan : C.dim}>{provider.baseUrl || "(not configured)"}</span>
      </text>
      <text>
        <span fg={C.blue} bold>
          {"Key:   "}
        </span>
        <span fg={provider.apiKey ? C.yellow : C.dim}>{maskKey(provider.apiKey)}</span>
      </text>
      <text>
        <span fg={C.blue} bold>
          {"Use:   "}
        </span>
        <span fg={C.cyan}>
          {provider.defaultModel
            ? `claudish --model ${provider.id}`
            : `claudish --model ${provider.id}@<model-id>`}
        </span>
      </text>
      {provider.error && (
        <text>
          <span fg={C.red}>{provider.error}</span>
        </text>
      )}
    </>
  );
}

/**
 * Render help when no custom provider is selected.
 */
function DefaultsHelpDetail() {
  return (
    <>
      <text>
        <span fg={C.fgMuted}>{"Press m to edit defaultModel or p to edit defaultProvider."}</span>
      </text>
      <text>
        <span fg={C.fgMuted}>{"Explicit provider@model always bypasses defaultProvider."}</span>
      </text>
    </>
  );
}

/**
 * Return the label for the current custom provider wizard step.
 */
function getWizardLabel(mode: string): string {
  const labels: Record<string, string> = {
    custom_provider_format: "compatible type",
    custom_provider_id: "provider-id",
    custom_provider_key: "api-key",
    custom_provider_model: "default model",
    custom_provider_url: "base_url",
  };
  return labels[mode] ?? "custom provider";
}

/**
 * Return the draft value shown for the current custom provider wizard step.
 */
function getWizardValue(mode: string, draft: CustomProviderDraft): string {
  const values: Record<string, string> = {
    custom_provider_id: draft.providerId,
    custom_provider_key: draft.apiKey,
    custom_provider_model: draft.defaultModel,
    custom_provider_url: draft.baseUrl,
  };
  return values[mode] ?? "";
}

/**
 * Return a compact provider type label for the custom provider table.
 */
function getProviderTypeText(provider: CustomProviderSummary): string {
  if (provider.kind === "simple") return provider.format || "simple";
  return provider.transport || provider.kind;
}
