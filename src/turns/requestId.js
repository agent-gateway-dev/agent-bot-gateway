export function buildTurnRequestId(params = {}) {
  const platform = sanitizePart(params.platform, "unknown");
  const routeId = sanitizePart(params.routeId, "route");
  const messageId = sanitizePart(params.messageId, "message");
  return `${platform}-${routeId}-${messageId}`;
}

function sanitizePart(value, fallback) {
  const text = String(value ?? "").trim();
  if (!text) {
    return fallback;
  }
  const normalized = text.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalized || fallback;
}
