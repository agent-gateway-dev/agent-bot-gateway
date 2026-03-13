const FEISHU_ROUTE_PREFIX = "feishu:";

export function makeFeishuRouteId(chatId) {
  const normalized = String(chatId ?? "").trim();
  return normalized ? `${FEISHU_ROUTE_PREFIX}${normalized}` : "";
}

export function parseFeishuRouteId(routeId) {
  const normalized = String(routeId ?? "").trim();
  if (!normalized.startsWith(FEISHU_ROUTE_PREFIX)) {
    return null;
  }
  const chatId = normalized.slice(FEISHU_ROUTE_PREFIX.length).trim();
  return chatId || null;
}

export function isFeishuRouteId(routeId) {
  return parseFeishuRouteId(routeId) !== null;
}
