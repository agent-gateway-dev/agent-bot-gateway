import fs from "node:fs/promises";
import path from "node:path";
import { Client, GatewayIntentBits } from "discord.js";
import { CodexRpcClient } from "../codexRpcClient.js";
import {
  maybeSendAttachmentsForItem as maybeSendAttachmentsForItemFromService,
  maybeSendInferredAttachmentsFromText as maybeSendInferredAttachmentsFromTextFromService
} from "../attachments/service.js";
import { createAttachmentInputBuilder } from "../attachments/inputBuilder.js";
import { createChannelMessaging } from "./channelMessaging.js";
import { createRuntimeAdapters } from "./runtimeAdapters.js";
import { isThreadNotFoundError } from "../codex/eventUtils.js";
import { createSandboxPolicyResolver } from "../codex/sandboxPolicy.js";
import { createTurnRunner } from "../codex/turnRunner.js";
import { sendChunkedToChannel as sendChunkedToChannelFromRenderer } from "../render/messageRenderer.js";
import { createTurnRecoveryStore } from "../turns/recoveryStore.js";
import { statusLabelForItemType, truncateStatusText } from "../turns/turnFormatting.js";
import { formatInputTextForSetup } from "./runtimeUtils.js";
import { isFeishuRouteId } from "../feishu/ids.js";

export async function buildRuntimeGraph(deps) {
  const { runtimeEnv, discordToken, execFileAsync, debugLog, discordMaxMessageLength, config, state } = deps;
  const {
    codexBin,
    imageCacheDir,
    maxImagesPerMessage,
    attachmentMaxBytes,
    attachmentRoots,
    attachmentInferFromText,
    attachmentsEnabled,
    attachmentItemTypes,
    attachmentIssueLimitPerTurn,
    inFlightRecoveryPath,
    extraWritableRoots,
    stripAnsiForDiscord
  } = runtimeEnv;

  const discord = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
  });
  const codex = new CodexRpcClient({
    codexBin
  });
  const refs = {
    runtimeOps: null,
    discordRuntime: null,
    backendRuntime: null,
    feishuRuntime: null,
    platformRegistry: null,
    notificationRuntime: null,
    serverRequestRuntime: null,
    shutdown: null,
    turnRunner: null
  };
  const fetchChannelByRouteId = async (routeId) => {
    if (refs.platformRegistry?.fetchChannelByRouteId) {
      return await refs.platformRegistry.fetchChannelByRouteId(routeId);
    }
    if (isFeishuRouteId(routeId)) {
      return (await refs.feishuRuntime?.fetchChannelByRouteId?.(routeId)) ?? null;
    }
    return await discord.channels.fetch(routeId).catch(() => null);
  };
  const channelMessaging = createChannelMessaging({
    fetchChannelByRouteId,
    stripAnsiForDiscord
  });
  const { safeReply, safeSendToChannel, safeSendToChannelPayload } = channelMessaging;
  const sandboxPolicyResolver = createSandboxPolicyResolver({
    path,
    execFileAsync,
    extraWritableRoots
  });
  const { buildSandboxPolicyForTurn } = sandboxPolicyResolver;
  const turnRecoveryStore = createTurnRecoveryStore({
    fs,
    path,
    recoveryPath: inFlightRecoveryPath,
    debugLog
  });
  await turnRecoveryStore.load();

  const queues = new Map();
  const activeTurns = new Map();
  const pendingApprovals = new Map();
  const processStartedAt = new Date().toISOString();
  let nextApprovalToken = 1;
  const createApprovalToken = () => String(nextApprovalToken++).padStart(4, "0");
  const attachmentInputBuilder = createAttachmentInputBuilder({
    fs,
    imageCacheDir,
    maxImagesPerMessage,
    discordToken,
    fetch,
    formatInputTextForSetup,
    logger: console
  });
  const runtimeAdapters = createRuntimeAdapters({
    attachmentInputBuilder,
    getTurnRunner: () => refs.turnRunner,
    getNotificationRuntime: () => refs.notificationRuntime,
    getServerRequestRuntime: () => refs.serverRequestRuntime,
    getDiscordRuntime: () => refs.discordRuntime,
    getPlatformRegistry: () => refs.platformRegistry,
    getRuntimeOps: () => refs.runtimeOps,
    maybeSendAttachmentsForItemFromService,
    maybeSendInferredAttachmentsFromTextFromService,
    sendChunkedToChannelFromRenderer,
    attachmentConfig: {
      attachmentsEnabled,
      attachmentItemTypes,
      attachmentMaxBytes,
      attachmentRoots,
      imageCacheDir,
      attachmentInferFromText,
      attachmentIssueLimitPerTurn
    },
    channelMessagingConfig: {
      statusLabelForItemType,
      safeSendToChannel,
      safeSendToChannelPayload,
      truncateStatusText,
      discordMaxMessageLength
    }
  });

  refs.turnRunner = createTurnRunner({
    queues,
    activeTurns,
    state,
    codex,
    config,
    safeReply,
    buildSandboxPolicyForTurn,
    isThreadNotFoundError,
    finalizeTurn: runtimeAdapters.finalizeTurn,
    onTurnReconnectPending: runtimeAdapters.onTurnReconnectPending,
    onTurnCreated: async (tracker) => {
      await turnRecoveryStore.upsertTurnFromTracker(tracker);
    },
    onTurnAborted: async (threadId, tracker) => {
      await turnRecoveryStore.removeTurn(threadId, {
        status: "cancelled",
        errorMessage: tracker?.failureMessage ?? null
      });
    },
    onActiveTurnsChanged: () => refs.runtimeOps?.writeHeartbeatFile()
  });

  return {
    fs,
    path,
    discord,
    codex,
    safeReply,
    safeSendToChannel,
    fetchChannelByRouteId,
    activeTurns,
    pendingApprovals,
    processStartedAt,
    refs,
    runtimeAdapters,
    turnRecoveryStore,
    createApprovalToken
  };
}
