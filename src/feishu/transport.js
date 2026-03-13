const FEISHU_TRANSPORT_WEBHOOK = "webhook";
const FEISHU_TRANSPORT_LONG_CONNECTION = "long-connection";

export function normalizeFeishuTransport(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  if (
    normalized === "long-connection" ||
    normalized === "long_connection" ||
    normalized === "longconnection" ||
    normalized === "ws" ||
    normalized === "websocket"
  ) {
    return FEISHU_TRANSPORT_LONG_CONNECTION;
  }

  return FEISHU_TRANSPORT_WEBHOOK;
}

export function isFeishuWebhookTransport(value) {
  return normalizeFeishuTransport(value) === FEISHU_TRANSPORT_WEBHOOK;
}

export function isFeishuLongConnectionTransport(value) {
  return normalizeFeishuTransport(value) === FEISHU_TRANSPORT_LONG_CONNECTION;
}

export { FEISHU_TRANSPORT_WEBHOOK, FEISHU_TRANSPORT_LONG_CONNECTION };
