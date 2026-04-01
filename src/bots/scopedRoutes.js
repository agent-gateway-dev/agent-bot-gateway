const SCOPED_ROUTE_PREFIX = "bot:";
const SCOPED_ROUTE_SEPARATOR = ":route:";
const LEGACY_FEISHU_PREFIX = "feishu:";

export function makeScopedRouteId(botId, externalRouteId) {
  const normalizedBotId = String(botId ?? "").trim();
  const normalizedRouteId = String(externalRouteId ?? "").trim();
  if (!normalizedBotId || !normalizedRouteId) {
    return "";
  }
  return `${SCOPED_ROUTE_PREFIX}${normalizedBotId}${SCOPED_ROUTE_SEPARATOR}${normalizedRouteId}`;
}

export function parseScopedRouteId(scopedRouteId) {
  const normalized = String(scopedRouteId ?? "").trim();
  if (!normalized.startsWith(SCOPED_ROUTE_PREFIX)) {
    return null;
  }
  const separatorIndex = normalized.indexOf(SCOPED_ROUTE_SEPARATOR, SCOPED_ROUTE_PREFIX.length);
  if (separatorIndex === -1) {
    return null;
  }
  const botId = normalized.slice(SCOPED_ROUTE_PREFIX.length, separatorIndex).trim();
  const externalRouteId = normalized.slice(separatorIndex + SCOPED_ROUTE_SEPARATOR.length).trim();
  if (!botId || !externalRouteId) {
    return null;
  }
  return { botId, externalRouteId };
}

export function isScopedRouteId(scopedRouteId) {
  return parseScopedRouteId(scopedRouteId) !== null;
}

export function parseLegacyRouteId(routeId) {
  const normalized = String(routeId ?? "").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith(LEGACY_FEISHU_PREFIX)) {
    const externalRouteId = normalized.slice(LEGACY_FEISHU_PREFIX.length).trim();
    return externalRouteId ? { platform: "feishu", externalRouteId } : null;
  }
  return {
    platform: "discord",
    externalRouteId: normalized
  };
}
