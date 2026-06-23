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

  return {
    messageId: stringField(message.message_id),
    chatId: stringField(message.chat_id),
    chatType,
    chatKind,
    messageType,
    senderOpenId: stringField(senderId?.open_id),
    senderName: stringField(sender.sender_name) || stringField(senderId?.open_id),
    text: stringField(content.text),
    content,
    mentions: normalizeMentions(message.mentions),
    raw: payload,
  };
}

export function resolveConversationKey(event: FeishuMessageEvent): string {
  if (event.chatKind === "direct") return `dm:${event.senderOpenId}`;
  return `group:${event.chatId}`;
}

export function extractImageKeys(event: FeishuMessageEvent | null | undefined): string[] {
  if (!event) return [];
  const keys = [event.content.image_key, event.content.imageKey, event.content.file_key]
    .map(stringField)
    .filter(Boolean);
  return Array.from(new Set(keys));
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
}): string {
  const trimmedText = input.text.trim();
  const text = trimmedText || (input.imagePaths.length > 0 ? "请分析这张图片。" : "");
  const prefixedText =
    input.chatKind === "group" && text ? `[${input.senderName || input.chatId}] ${text}` : text;
  const lines = [prefixedText, ...input.imagePaths].filter(Boolean);
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
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
