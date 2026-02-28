import path from "node:path";

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

export function redactLocalPathsForDiscord(text) {
  if (typeof text !== "string" || !text) {
    return "";
  }

  let redacted = text.replace(/\]\(((?:\/|~\/)[^)]+)\)/g, (match, localPath) => `](${path.basename(localPath)})`);
  redacted = redacted.replace(
    /(^|[\s([`'"])((?:\/|~\/)[^)\]`'"<>\r\n]+)(?=$|[\s)\]`'",.!?:;])/g,
    (full, prefix, localPath) => `${prefix}${path.basename(localPath)}`
  );

  return redacted;
}

export async function sendChunkedToChannel(channel, text, safeSendToChannel, limit = 1900) {
  const chunks = splitForDiscord(text, limit);
  for (const chunk of chunks) {
    await safeSendToChannel(channel, chunk);
  }
}
