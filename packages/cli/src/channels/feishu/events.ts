export type FeishuChatKind = "direct" | "group";

export interface FeishuMention {
  openId?: string;
  name?: string;
  key?: string;
}

export interface FeishuMessageEvent {
  messageId: string;
  chatId: string;
  chatType: string;
  chatKind: FeishuChatKind;
  messageType: string;
  senderOpenId: string;
  senderName: string;
  text: string;
  content: Record<string, unknown>;
  mentions: FeishuMention[];
  raw: unknown;
}

export interface FeishuFileResource {
  fileKey: string;
  fileName?: string;
}

export function parseFeishuMessageEvent(payload: unknown): FeishuMessageEvent | null {
  const event = recordField(payload, "event");
  const message = recordField(event, "message");
  const sender = recordField(event, "sender");
  if (!message || !sender) return null;

  const chatType = stringField(message.chat_type);
  const messageType = stringField(message.message_type);
  const content = parseContent(message.content);
  const senderId = recordField(sender, "sender_id");
  const chatKind: FeishuChatKind = chatType === "p2p" ? "direct" : "group";
  const mentions = [...normalizeMentions(message.mentions), ...extractPostMentions(content)];

  return {
    messageId: stringField(message.message_id),
    chatId: stringField(message.chat_id),
    chatType,
    chatKind,
    messageType,
    senderOpenId: stringField(senderId?.open_id),
    senderName: stringField(sender.sender_name) || stringField(senderId?.open_id),
    text: extractMessageText(messageType, content),
    content,
    mentions,
    raw: payload,
  };
}

export function resolveConversationKey(event: FeishuMessageEvent): string {
  if (event.chatKind === "direct") return `dm:${event.senderOpenId}`;
  return `group:${event.chatId}`;
}

export function extractImageKeys(event: FeishuMessageEvent | null | undefined): string[] {
  if (!event) return [];
  const keys = [
    event.content.image_key,
    event.content.imageKey,
    ...extractPostImageKeys(event.content),
  ]
    .map(stringField)
    .filter(Boolean);
  return Array.from(new Set(keys));
}

export function extractFileResources(
  event: FeishuMessageEvent | null | undefined
): FeishuFileResource[] {
  if (!event) return [];

  const resources: FeishuFileResource[] = [];
  if (event.messageType === "file") {
    resources.push(fileResourceFromRecord(event.content));
  }
  resources.push(...extractPostFileResources(event.content));

  const unique = new Map<string, FeishuFileResource>();
  for (const resource of resources) {
    if (!resource.fileKey) continue;
    unique.set(resource.fileKey, resource);
  }
  return Array.from(unique.values());
}

export function stripBotMention(
  text: string,
  mentions: FeishuMention[],
  botOpenId: string
): string {
  let result = text;
  const botMention = mentions.find((mention) => mention.openId === botOpenId);
  if (botMention?.name) {
    result = result.replace(new RegExp(`@${escapeRegExp(botMention.name)}\\s*`, "g"), "");
  }
  result = result.replace(
    new RegExp(`<at\\s+user_id=["']${escapeRegExp(botOpenId)}["'][^>]*>.*?<\\/at>\\s*`, "g"),
    ""
  );
  return result.trim();
}

export function shouldHandleMessage(event: FeishuMessageEvent, botOpenId: string): boolean {
  if (event.chatKind === "direct") return true;
  return event.mentions.some((mention) => mention.openId === botOpenId);
}

export function buildClaudeCodeInputForFeishu(input: {
  chatKind: FeishuChatKind;
  chatId: string;
  senderName: string;
  text: string;
  imagePaths: string[];
  filePaths?: string[];
}): string {
  const filePaths = input.filePaths ?? [];
  const trimmedText = input.text.trim();
  const text =
    trimmedText || (input.imagePaths.length > 0 && filePaths.length === 0 ? "请分析这张图片。" : "");
  const prefixedText =
    input.chatKind === "group" && text ? `[${input.senderName || input.chatId}] ${text}` : text;
  const lines = [prefixedText, ...input.imagePaths, ...filePaths].filter(Boolean);
  return `${lines.join("\n")}\n`;
}

function normalizeMentions(input: unknown): FeishuMention[] {
  if (!Array.isArray(input)) return [];

  return input.map((mention) => {
    const id = recordField(mention, "id");
    return {
      openId: stringField(id?.open_id),
      name: stringField((mention as Record<string, unknown>).name),
      key: stringField((mention as Record<string, unknown>).key),
    };
  });
}

function extractMessageText(messageType: string, content: Record<string, unknown>): string {
  if (messageType === "post") {
    return renderPostText(content);
  }

  return stringField(content.text);
}

function renderPostText(content: Record<string, unknown>): string {
  return postRowsFromContent(content)
    .map((row) => row.map(renderPostElement).join("").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function renderPostElement(element: unknown): string {
  if (!isRecord(element)) return stringField(element);

  const tag = stringField(element.tag).toLowerCase();
  if (tag === "at") return renderPostMentionElement(element);
  if (tag === "br") return "\n";
  if (tag === "img" || tag === "media") return "";
  if (tag === "a") return stringField(element.text) || stringField(element.href);

  return stringField(element.text) || stringField(element.content);
}

function renderPostMentionElement(element: Record<string, unknown>): string {
  const openId = stringField(element.open_id) || stringField(element.user_id);
  const name =
    stringField(element.user_name) ||
    stringField(element.name) ||
    stringField(element.text) ||
    stringField(element.content) ||
    openId;
  return openId ? `<at user_id="${openId}">${escapeAtName(name)}</at>` : `@${name}`;
}

function extractPostMentions(content: Record<string, unknown>): FeishuMention[] {
  return postRowsFromContent(content)
    .flat()
    .filter(isRecord)
    .filter((element) => stringField(element.tag).toLowerCase() === "at")
    .map((element) => ({
      openId: stringField(element.open_id) || stringField(element.user_id),
      name:
        stringField(element.user_name) ||
        stringField(element.name) ||
        stringField(element.text) ||
        stringField(element.content),
      key: stringField(element.key),
    }))
    .filter((mention) => Boolean(mention.openId));
}

function extractPostImageKeys(content: Record<string, unknown>): string[] {
  return postRowsFromContent(content)
    .flat()
    .filter(isRecord)
    .filter((element) => stringField(element.tag).toLowerCase() === "img")
    .map((element) => stringField(element.image_key) || stringField(element.imageKey))
    .filter(Boolean);
}

function extractPostFileResources(content: Record<string, unknown>): FeishuFileResource[] {
  return postRowsFromContent(content)
    .flat()
    .filter(isRecord)
    .filter((element) => stringField(element.tag).toLowerCase() === "file")
    .map(fileResourceFromRecord)
    .filter((resource) => Boolean(resource.fileKey));
}

function fileResourceFromRecord(record: Record<string, unknown>): FeishuFileResource {
  const fileKey = stringField(record.file_key) || stringField(record.fileKey);
  const fileName =
    stringField(record.file_name) || stringField(record.fileName) || stringField(record.name);
  return fileName ? { fileKey, fileName } : { fileKey };
}

function postRowsFromContent(content: Record<string, unknown>): unknown[][] {
  const directRows = postRowsFromValue(content.content);
  if (directRows.length > 0) return directRows;

  for (const value of Object.values(content)) {
    if (!isRecord(value)) continue;
    const localizedRows = postRowsFromValue(value.content);
    if (localizedRows.length > 0) return localizedRows;
  }

  return [];
}

function postRowsFromValue(value: unknown): unknown[][] {
  if (!Array.isArray(value) || value.length === 0) return [];
  return value.every(Array.isArray) ? (value as unknown[][]) : [value];
}

function parseContent(input: unknown): Record<string, unknown> {
  if (typeof input !== "string") return {};
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function recordField(input: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return isRecord(value) ? value : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function stringField(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

function escapeAtName(value: string): string {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
