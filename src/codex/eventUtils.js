export function extractThreadId(params) {
  if (typeof params?.threadId === "string") {
    return params.threadId;
  }
  if (typeof params?.conversationId === "string") {
    return params.conversationId;
  }
  if (typeof params?.item?.threadId === "string") {
    return params.item.threadId;
  }
  if (typeof params?.turn?.threadId === "string") {
    return params.turn.threadId;
  }
  return null;
}

export function extractAgentMessageText(item) {
  if (!item || item.type !== "agentMessage") {
    return "";
  }
  if (typeof item.text === "string" && item.text.trim()) {
    return item.text;
  }
  if (Array.isArray(item.content)) {
    const textParts = [];
    for (const part of item.content) {
      if (typeof part === "string") {
        textParts.push(part);
        continue;
      }
      if (typeof part?.text === "string") {
        textParts.push(part.text);
      }
    }
    return textParts.join("");
  }
  return "";
}

export function isThreadNotFoundError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("thread not found") || message.includes("unknown thread");
}

export function isTransientReconnectErrorMessage(message) {
  const normalized = String(message ?? "").toLowerCase();
  return (
    /reconnecting\.\.\.\s*\d+\/\d+/i.test(normalized) ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("connection reset") ||
    normalized.includes("connection closed") ||
    normalized.includes("connection lost") ||
    normalized.includes("econnreset")
  );
}
