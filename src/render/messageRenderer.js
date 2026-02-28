export function normalizeRenderVerbosity(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "ops" || normalized === "debug") {
    return normalized;
  }
  return "user";
}

export function buildTurnRenderPlan({ summaryText, diffBlock, verbosity = "user" }) {
  const primaryMessage = sanitizeSummaryForDiscord(summaryText);
  const statusMessages = [];
  if (typeof diffBlock === "string" && diffBlock.trim()) {
    if (verbosity === "ops" || verbosity === "debug") {
      statusMessages.push(diffBlock);
    }
  }
  return {
    primaryMessage,
    statusMessages,
    attachments: []
  };
}

export function sanitizeSummaryForDiscord(text) {
  return String(text ?? "").trim();
}

export function truncateForDiscordMessage(text, limit = 1900) {
  if (typeof text !== "string") {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  const suffix = "\n...[truncated]";
  const headLimit = Math.max(0, limit - suffix.length);
  return `${text.slice(0, headLimit)}${suffix}`;
}

export function splitForDiscord(text, limit = 1900) {
  if (text.length <= limit) {
    return [text];
  }
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += limit) {
    chunks.push(text.slice(offset, offset + limit));
  }
  return chunks;
}

export async function sendChunkedToChannel(channel, text, safeSendToChannel, limit = 1900) {
  const chunks = splitForDiscord(text, limit);
  for (const chunk of chunks) {
    await safeSendToChannel(channel, chunk);
  }
}
