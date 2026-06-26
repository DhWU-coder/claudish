export interface FeishuDraftSanitizerOptions {
  dropWhenNoReply?: boolean;
}

export function sanitizeFeishuLeakedDraftText(
  text: string,
  options: FeishuDraftSanitizerOptions = {}
): string {
  const trimmed = text.trim();
  if (!trimmed || !startsWithLeakedDraft(trimmed)) return trimmed;

  const replyStart = findLikelyChineseReplyStart(trimmed);
  if (replyStart < 0) return options.dropWhenNoReply ? "" : trimmed;

  const cleaned = trimmed.slice(replyStart).trim();
  if (cleaned) return cleaned;
  return options.dropWhenNoReply ? "" : trimmed;
}

function startsWithLeakedDraft(text: string): boolean {
  if (!/^\*\*[A-Za-z][A-Za-z0-9\s:;,'".!?/-]{3,100}\*\*/.test(text)) return false;

  const head = text.slice(0, 1200).replace(/\s+/g, " ").toLowerCase();
  return DRAFT_LEAKAGE_MARKERS.some((marker) => head.includes(marker));
}

function findLikelyChineseReplyStart(text: string): number {
  for (const match of text.matchAll(/[\u3400-\u9fff]/g)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const previous = previousNonWhitespace(text, index);
    if (previous && !isReplyBoundary(previous)) continue;
    if (looksLikeChineseReply(text.slice(index))) return index;
  }
  return -1;
}

function previousNonWhitespace(text: string, index: number): string {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = text[cursor];
    if (char && !/\s/.test(char)) return char;
  }
  return "";
}

function isReplyBoundary(char: string): boolean {
  return /[.!?。！？:：;；\n\r]/.test(char);
}

function looksLikeChineseReply(text: string): boolean {
  const sample = text.slice(0, 100);
  const chineseCount = Array.from(sample).filter((char) => /[\u3400-\u9fff]/.test(char)).length;
  if (chineseCount < 4) return false;
  return /[，。！？；：、]/.test(sample) || chineseCount >= 8;
}

const DRAFT_LEAKAGE_MARKERS = [
  "i need to",
  "i should",
  "i suspect",
  "maybe i",
  "i'm planning",
  "i will verify",
  "i'll write",
  "it feels like",
  "the user requested",
  "the tool displayed",
  "base64 format",
  "there's definitely",
  "there is definitely",
  "i'm thinking",
  "i’m thinking",
  "i wonder",
  "i could say",
  "i want to",
  "i'm excited",
  "i’m excited",
];
