import * as FeishuSdk from "@larksuiteoapi/node-sdk";
import { HttpsProxyAgent } from "https-proxy-agent";
import { makeFeishuRouteId, parseFeishuRouteId } from "./ids.js";
import { resolveFeishuContext } from "./context.js";
import { isFeishuLongConnectionTransport, isFeishuWebhookTransport, normalizeFeishuTransport } from "./transport.js";

export function createFeishuRuntime(deps) {
  const {
    config,
    runtimeEnv,
    getChannelSetups,
    runManagedRouteCommand,
    getHelpText,
    isCommandSupportedForPlatform,
    handleCommand,
    handleSetPathCommand,
    runtimeAdapters,
    safeReply,
    feishuSdk = FeishuSdk
  } = deps;
  const {
    feishuEnabled,
    feishuAppId,
    feishuAppSecret,
    feishuVerificationToken,
    feishuTransport,
    feishuWebhookPath,
    feishuGeneralChatId,
    feishuGeneralCwd,
    feishuRequireMentionInGroup
  } = runtimeEnv;

  const seenEventIds = new Map();
  const sentMessages = new Map();
  const transport = normalizeFeishuTransport(feishuTransport);
  const proxyUrl = getProxyUrl();
  const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
  let wsClient = null;
  let tenantAccessToken = "";
  let tenantAccessTokenExpiresAt = 0;

  async function fetchChannelByRouteId(routeId) {
    const chatId = parseFeishuRouteId(routeId);
    if (!chatId) {
      return null;
    }
    return createChannel(chatId);
  }

  async function handleHttpRequest(request, response, options = {}) {
    const method = String(request.method ?? "").toUpperCase();
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (!isFeishuWebhookTransport(transport) || method !== "POST" || pathname !== feishuWebhookPath) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 404, msg: "not found" }));
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readRequestBody(request));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 400, msg: "invalid json" }));
      return;
    }

    if (!isValidVerificationToken(payload)) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 403, msg: "invalid token" }));
      return;
    }

    if (isUrlVerification(payload)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ challenge: payload.challenge }));
      return;
    }

    if (options.ready === false) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 503, msg: "bridge not ready" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: 0 }));

    try {
      await processEventPayload(payload);
    } catch (error) {
      console.error(`feishu event processing failed: ${error.message}`);
    }
  }

  async function processEventPayload(payload) {
    const eventType = String(payload?.header?.event_type ?? "");
    if (eventType !== "im.message.receive_v1") {
      return;
    }

    await processMessageReceiveEvent(payload?.event, {
      eventId: String(payload?.header?.event_id ?? "")
    });
  }

  async function processMessageReceiveEvent(event, options = {}) {
    const eventId = String(options?.eventId ?? "").trim() || buildLongConnectionEventId(event);
    if (eventId && markEventSeen(eventId)) {
      return;
    }

    const senderType = String(event?.sender?.sender_type ?? "");
    if (senderType && senderType !== "user") {
      return;
    }

    const message = event?.message;
    if (!message || String(message.message_type ?? "") !== "text") {
      return;
    }

    const senderOpenId = String(event?.sender?.sender_id?.open_id ?? "").trim();
    if (!isAllowedUser(senderOpenId)) {
      console.warn(`ignoring Feishu message from filtered user ${senderOpenId || "(unknown)"}`);
      return;
    }

    const text = normalizeIncomingText(extractTextMessageContent(message.content));
    if (!text) {
      return;
    }
    if (!shouldHandleIncomingText(message, text)) {
      return;
    }

    const channel = createChannel(message.chat_id, {
      chatType: message.chat_type,
      sourceMessageId: message.message_id
    });
    const inboundMessage = createInboundMessage({
      messageId: message.message_id,
      senderOpenId,
      channel,
      text
    });

    const normalizedCommand = normalizeCommandText(text);
    if (normalizedCommand === "!help") {
      await safeReply(inboundMessage, getHelpText({ platformId: "feishu" }));
      return;
    }

    if (normalizedCommand === "!where") {
      const context = resolveFeishuContext(inboundMessage, {
        channelSetups: getChannelSetups(),
        config,
        generalChat: {
          id: feishuGeneralChatId,
          cwd: feishuGeneralCwd
        }
      });
      await safeReply(inboundMessage, buildFeishuWhereText({ inboundMessage, senderOpenId, context }));
      return;
    }

    if (normalizedCommand.startsWith("!setpath")) {
      const rest = normalizedCommand.replace(/^!setpath\b/i, "").trim();
      await handleSetPathCommand(inboundMessage, rest);
      return;
    }

    if (normalizedCommand === "!resync") {
      await runManagedRouteCommand(inboundMessage, { forceRebuild: false });
      return;
    }

    if (normalizedCommand === "!rebuild") {
      await runManagedRouteCommand(inboundMessage, { forceRebuild: true });
      return;
    }

    if (normalizedCommand.startsWith("!initrepo")) {
      if (!isCommandSupportedForPlatform?.("initrepo", "feishu")) {
        await safeReply(
          inboundMessage,
          "This platform does not support `initrepo`. Add `feishu:<chat_id>` to `config/channels.json` instead."
        );
        return;
      }
      await safeReply(
        inboundMessage,
        "Feishu chat bindings are config-driven. Add `feishu:<chat_id>` to `config/channels.json` instead of using `!initrepo`."
      );
      return;
    }

    const context = resolveFeishuContext(inboundMessage, {
      channelSetups: getChannelSetups(),
      config,
      generalChat: {
        id: feishuGeneralChatId,
        cwd: feishuGeneralCwd
      }
    });
    if (!context) {
      await safeReply(
        inboundMessage,
        [
          "This Feishu chat is not bound to a repo.",
          `chat_id: \`${message.chat_id}\``,
          `route_id: \`${makeFeishuRouteId(message.chat_id)}\``,
          `sender_open_id: \`${senderOpenId || "(unknown)"}\``,
          "Add the route_id above to `config/channels.json`, or set `FEISHU_GENERAL_CHAT_ID` for a read-only general chat.",
          "Tip: send `/where` in this chat to inspect identifiers again."
        ].join("\n")
      );
      return;
    }

    if (normalizedCommand.startsWith("!")) {
      await handleCommand(inboundMessage, normalizedCommand, context);
      return;
    }

    const inputItems = await runtimeAdapters.buildTurnInputFromMessage(inboundMessage, text, [], context.setup);
    if (inputItems.length === 0) {
      return;
    }
    runtimeAdapters.enqueuePrompt(context.repoChannelId, {
      inputItems,
      message: inboundMessage,
      setup: context.setup,
      repoChannelId: context.repoChannelId
    });
  }

  async function start() {
    if (!feishuEnabled) {
      return {
        started: false,
        transport
      };
    }

    if (!isFeishuLongConnectionTransport(transport)) {
      return {
        started: true,
        transport,
        webhookPath: feishuWebhookPath
      };
    }

    if (wsClient) {
      return {
        started: true,
        transport
      };
    }

    const wsOptions = {
      appId: feishuAppId,
      appSecret: feishuAppSecret,
      loggerLevel: feishuSdk.LoggerLevel?.warn
    };

    if (proxyAgent) {
      wsOptions.agent = proxyAgent;
      if (feishuSdk.defaultHttpInstance?.defaults) {
        feishuSdk.defaultHttpInstance.defaults.proxy = false;
        feishuSdk.defaultHttpInstance.defaults.httpAgent = proxyAgent;
        feishuSdk.defaultHttpInstance.defaults.httpsAgent = proxyAgent;
      }
      wsOptions.httpInstance = feishuSdk.defaultHttpInstance;
    }

    wsClient = new feishuSdk.WSClient(wsOptions);
    const eventDispatcher = new feishuSdk.EventDispatcher({
      verificationToken: feishuVerificationToken || undefined,
      loggerLevel: feishuSdk.LoggerLevel?.warn
    }).register({
      "im.message.receive_v1": async (event) => {
        await processMessageReceiveEvent(event);
      }
    });

    await wsClient.start({ eventDispatcher });

    return {
      started: true,
      transport
    };
  }

  function stop() {
    wsClient?.close?.({ force: true });
    wsClient = null;
  }

  function createChannel(chatId, options = {}) {
    const routeId = makeFeishuRouteId(chatId);
    const isGeneral = feishuGeneralChatId && String(chatId) === String(feishuGeneralChatId);
    return {
      id: routeId,
      chatId,
      platform: "feishu",
      bridgeMeta: {
        mode: isGeneral ? "general" : "repo",
        allowFileWrites: !isGeneral
      },
      isTextBased() {
        return true;
      },
      async send(payload) {
        return await sendTextMessage({
          chatId,
          text: extractOutgoingText(payload),
          replyToMessageId: options.sourceMessageId
        });
      },
      messages: {
        fetch: async (messageId) => sentMessages.get(String(messageId)) ?? null,
        edit: async (messageId, payload) => {
          const existing = sentMessages.get(String(messageId));
          if (!existing) {
            return null;
          }
          return await existing.edit(payload);
        }
      }
    };
  }

  function createInboundMessage({ messageId, senderOpenId, channel, text }) {
    return {
      id: messageId,
      platform: "feishu",
      content: text,
      author: {
        id: senderOpenId,
        bot: false
      },
      channel,
      channelId: channel.id,
      attachments: new Map(),
      async reply(payload) {
        return await sendTextMessage({
          chatId: channel.chatId,
          text: extractOutgoingText(payload),
          replyToMessageId: messageId
        });
      }
    };
  }

  async function sendTextMessage({ chatId, text, replyToMessageId }) {
    const normalizedText = String(text ?? "").trim();
    if (!normalizedText) {
      return null;
    }
    let response;
    if (replyToMessageId) {
      response = await feishuRequest(`/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`, {
        method: "POST",
        body: {
          msg_type: "text",
          content: JSON.stringify({ text: normalizedText })
        }
      });
    } else {
      response = await feishuRequest(`/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        body: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: normalizedText })
        }
      });
    }

    const messageId =
      String(response?.data?.message_id ?? response?.message_id ?? "").trim() ||
      `feishu-local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const channel = createChannel(chatId, {
      sourceMessageId: replyToMessageId
    });
    const sent = {
      id: messageId,
      platform: "feishu",
      content: normalizedText,
      channel,
      channelId: channel.id,
      async edit(payload) {
        this.content = extractOutgoingText(payload);
        return this;
      }
    };
    sentMessages.set(messageId, sent);
    return sent;
  }

  async function feishuRequest(pathname, options = {}) {
    const token = await getTenantAccessToken();
    const response = await fetch(`https://open.feishu.cn${pathname}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload?.code ?? 0) !== 0) {
      const code = Number(payload?.code ?? response.status);
      const msg = String(payload?.msg ?? `HTTP ${response.status}`);
      throw new Error(`Feishu API failed (${code}): ${msg}`);
    }
    return payload;
  }

  async function getTenantAccessToken() {
    const now = Date.now();
    if (tenantAccessToken && tenantAccessTokenExpiresAt - 60_000 > now) {
      return tenantAccessToken;
    }
    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        app_id: feishuAppId,
        app_secret: feishuAppSecret
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload?.code ?? 0) !== 0 || !payload?.tenant_access_token) {
      const code = Number(payload?.code ?? response.status);
      const msg = String(payload?.msg ?? `HTTP ${response.status}`);
      throw new Error(`Feishu token request failed (${code}): ${msg}`);
    }
    tenantAccessToken = String(payload.tenant_access_token);
    tenantAccessTokenExpiresAt = now + Math.max(60_000, Number(payload?.expire ?? 7200) * 1000);
    return tenantAccessToken;
  }

  function isAllowedUser(openId) {
    if (!Array.isArray(config.allowedFeishuUserIds) || config.allowedFeishuUserIds.length === 0) {
      return true;
    }
    return config.allowedFeishuUserIds.includes(openId);
  }

  function shouldHandleIncomingText(message, text) {
    const normalized = String(text ?? "").trim();
    if (!normalized) {
      return false;
    }
    if (/^[!/]/.test(normalized)) {
      return true;
    }
    const chatType = String(message?.chat_type ?? "");
    if (chatType === "p2p") {
      return true;
    }
    if (!feishuRequireMentionInGroup) {
      return true;
    }
    return Array.isArray(message?.mentions) && message.mentions.length > 0;
  }

  function isValidVerificationToken(payload) {
    if (!feishuVerificationToken) {
      return true;
    }
    return String(payload?.token ?? payload?.header?.token ?? "").trim() === feishuVerificationToken;
  }

  function isUrlVerification(payload) {
    return String(payload?.type ?? "").trim() === "url_verification" && typeof payload?.challenge === "string";
  }

  function markEventSeen(eventId) {
    const now = Date.now();
    for (const [key, timestamp] of seenEventIds.entries()) {
      if (now - timestamp > 10 * 60_000) {
        seenEventIds.delete(key);
      }
    }
    if (seenEventIds.has(eventId)) {
      return true;
    }
    seenEventIds.set(eventId, now);
    return false;
  }

  return {
    enabled: feishuEnabled,
    transport,
    webhookPath: isFeishuWebhookTransport(transport) ? feishuWebhookPath : "",
    fetchChannelByRouteId,
    start,
    stop,
    handleHttpRequest,
    handleEventPayload: processEventPayload
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function extractTextMessageContent(rawContent) {
  if (typeof rawContent !== "string" || !rawContent.trim()) {
    return "";
  }
  try {
    const parsed = JSON.parse(rawContent);
    return typeof parsed?.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

function normalizeIncomingText(text) {
  return String(text ?? "")
    .replace(/\u200B/g, "")
    .replace(/^(?:@\S+\s*)+/, "")
    .trim();
}

function normalizeCommandText(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith("/")) {
    return `!${normalized.slice(1).trim()}`;
  }
  return normalized;
}

function buildLongConnectionEventId(event) {
  const messageId = String(event?.message?.message_id ?? "").trim();
  if (messageId) {
    return `message:${messageId}`;
  }
  return "";
}

function getProxyUrl() {
  return (
    String(process.env.HTTPS_PROXY ?? "").trim() ||
    String(process.env.https_proxy ?? "").trim() ||
    String(process.env.HTTP_PROXY ?? "").trim() ||
    String(process.env.http_proxy ?? "").trim()
  );
}

function extractOutgoingText(payload) {
  if (typeof payload === "string") {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return String(payload ?? "");
  }

  const lines = [];
  if (typeof payload.content === "string" && payload.content.trim()) {
    lines.push(payload.content.trim());
  }
  if (Array.isArray(payload.files) && payload.files.length > 0) {
    const fileNames = payload.files
      .map((entry) => String(entry?.name ?? entry?.attachment ?? "").trim())
      .filter((value) => value.length > 0);
    if (fileNames.length > 0) {
      lines.push(`Files: ${fileNames.join(", ")}`);
    }
  }
  return lines.join("\n").trim();
}

function buildFeishuWhereText({ inboundMessage, senderOpenId, context }) {
  const routeId = String(inboundMessage?.channelId ?? "").trim();
  const chatId = String(inboundMessage?.channel?.chatId ?? "").trim();
  const lines = [
    "platform: `feishu`",
    `chat_id: \`${chatId || "(unknown)"}\``,
    `route_id: \`${routeId || "(unknown)"}\``,
    `sender_open_id: \`${senderOpenId || "(unknown)"}\``
  ];

  if (!context) {
    lines.push("binding: none");
    lines.push("Add the route_id to `config/channels.json`, or set `FEISHU_GENERAL_CHAT_ID` for a read-only general chat.");
    return lines.join("\n");
  }

  const threadMode = context.setup.mode === "general" ? "general" : "repo";
  const fileWrites = context.setup.allowFileWrites === false ? "disabled" : "enabled";
  lines.push(`binding: \`${threadMode}\``);
  lines.push(`cwd: \`${context.setup.cwd}\``);
  lines.push(`model: \`${context.setup.model}\``);
  lines.push(`sandbox mode: \`${context.setup.sandboxMode}\``);
  lines.push(`file writes: \`${fileWrites}\``);
  return lines.join("\n");
}
