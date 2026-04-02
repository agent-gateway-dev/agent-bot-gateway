import { buildCommandRuntime } from "./buildCommandRuntime.js";
import { buildBackendRuntime } from "./buildBackendRuntime.js";
import { buildNotificationRuntime } from "./buildNotificationRuntime.js";
import { buildApprovalRuntime } from "./buildApprovalRuntime.js";
import { createPlatformRegistry } from "../platforms/platformRegistry.js";
import { DISCORD_CHANNEL_TYPES, DISCORD_MESSAGE_FLAGS } from "../discord/constants.js";
import { createDiscordClient } from "../discord/createDiscordClient.js";

export async function buildBridgeRuntimes(deps) {
  const {
    runtimeContext,
    runtimeEnv,
    runtimeServices,
    channelSetupStore,
    ioRuntime
  } = deps;
  const {
    path,
    fs,
    execFileAsync,
    discord,
    discordToken,
    fetchChannelByRouteId,
    processStartedAt,
    codex,
    agentClientRegistry,
    config,
    state,
    activeTurns,
    pendingApprovals
  } = runtimeContext;
  const {
    approvalButtonPrefix,
    projectsCategoryName,
    managedChannelTopicPrefix,
    managedThreadTopicPrefix,
    repoRootPath,
    codexBin,
    codexHomeEnv,
    statePath,
    configPath,
    renderVerbosity,
    disableStreamingOutput,
    discordMessageChunkLimit,
    feishuMessageChunkLimit,
    backendHttpEnabled,
    backendHttpHost,
    backendHttpPort,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
    feishuEnabled,
    feishuAppId,
    feishuAppSecret,
    feishuVerificationToken,
    feishuTransport,
    feishuPort,
    feishuHost,
    feishuWebhookPath,
    imageCacheDir,
    feishuGeneralChatId,
    feishuGeneralCwd,
    feishuUnboundChatMode,
    feishuUnboundChatCwd,
    feishuRequireMentionInGroup,
    feishuSegmentedStreaming,
    feishuStreamMinChars,
    feishuEventDedupeTtlMs,
    feishuEventDedupePath,
    feishuStatusReactions
  } = runtimeEnv;
  const { getChannelSetups, setChannelSetups } = channelSetupStore;
  const {
    runtimeAdapters,
    safeReply,
    safeSendToChannel,
    safeAddReaction,
    debugLog,
    turnRecoveryStore,
    createApprovalToken,
    sendChunkedToChannel
  } = runtimeServices;
  const { waitForDiscordReady, isDiscordMissingPermissionsError } = ioRuntime;

  let platformRegistry = null;
  const getPlatformRegistry = () => platformRegistry;
  const buildScopedCommandRuntime = (bot, discordClient = null) =>
    buildCommandRuntime({
      bot,
      ChannelType: DISCORD_CHANNEL_TYPES,
      path,
      fs,
      execFileAsync,
      discord: discordClient,
      codex,
      config,
      state,
      pendingApprovals,
      projectsCategoryName,
      repoRootPath,
      managedThreadTopicPrefix,
      managedChannelTopicPrefix,
      codexBin,
      codexHomeEnv,
      statePath,
      configPath,
      isDiscordMissingPermissionsError,
      getChannelSetups,
      setChannelSetups,
      runtimeAdapters,
      safeReply,
      getPlatformRegistry
    });

  const notificationRuntime = buildNotificationRuntime({
    activeTurns,
    renderVerbosity,
    disableStreamingOutput,
    discordMaxMessageLength: discordMessageChunkLimit,
    feishuMaxMessageLength: feishuMessageChunkLimit,
    feishuSegmentedStreaming,
    feishuStreamMinChars,
    runtimeAdapters,
    safeSendToChannel,
    safeAddReaction,
    feishuStatusReactions,
    debugLog,
    turnRecoveryStore,
    sendChunkedToChannel,
    onSessionIdUpdate: async (oldSessionId, newSessionId) => {
      // Update state binding when Claude SDK provides a real session ID
      console.log(`[buildRuntimes] onSessionIdUpdate: ${oldSessionId} -> ${newSessionId}`);
      const repoChannelId = state.findConversationChannelIdByAgentThreadId(oldSessionId);
      if (repoChannelId) {
        const binding = state.getBinding(repoChannelId);
        if (binding) {
          binding.codexThreadId = newSessionId;
          state.setBinding(repoChannelId, binding);
          await state.save();
          console.log(`[buildRuntimes] Updated binding for ${repoChannelId}: ${oldSessionId} -> ${newSessionId}`);
        }
      }
    }
  });

  const serverRequestRuntime = buildApprovalRuntime({
    codex,
    agentClientRegistry,
    state,
    activeTurns,
    pendingApprovals,
    approvalButtonPrefix,
    safeSendToChannel,
    createApprovalToken,
    fetchChannelByRouteId
  });

  let discordRuntime = createDisabledDiscordRuntime();
  let feishuRuntime = createDisabledFeishuRuntime({ feishuTransport, feishuWebhookPath });
  let primaryBootstrapChannelMappings = async () => null;
  const platforms = [];
  const configuredBots = listConfiguredBots(config);
  const botsForStartup =
    configuredBots.length > 0
      ? configuredBots
      : [
          ...(discordToken
            ? [
                {
                  botId: "discord",
                  platform: "discord",
                  runtime: config?.runtime ?? "codex",
                  auth: { token: discordToken },
                  settings: {}
                }
              ]
            : []),
          ...(feishuEnabled
            ? [
                {
                  botId: "feishu",
                  platform: "feishu",
                  runtime: config?.runtime ?? "codex",
                  auth: {
                    appId: feishuAppId,
                    appSecret: feishuAppSecret,
                    verificationToken: feishuVerificationToken
                  },
                  settings: {
                    transport: feishuTransport,
                    webhookPath: feishuWebhookPath,
                    generalChatId: feishuGeneralChatId,
                    generalCwd: feishuGeneralCwd
                  }
                }
              ]
            : [])
        ];
  const discordBotsForStartup = botsForStartup.filter(
    (entry) => entry.platform === "discord" && String(entry.auth?.token ?? "").trim()
  );
  const feishuBotsForStartup = botsForStartup.filter((entry) => entry.platform === "feishu");

  let buildDiscordRuntime = null;
  let createDiscordPlatform = null;
  if (discordBotsForStartup.length > 0) {
    [{ buildDiscordRuntime }, { createDiscordPlatform }] = await Promise.all([
      import("./buildDiscordRuntime.js"),
      import("../platforms/discordPlatform.js")
    ]);
  }

  let buildFeishuRuntime = null;
  let createFeishuPlatform = null;
  if (feishuBotsForStartup.length > 0) {
    [{ buildFeishuRuntime }, { createFeishuPlatform }] = await Promise.all([
      import("./buildFeishuRuntime.js"),
      import("../platforms/feishuPlatform.js")
    ]);
  }

  let primaryDiscordAssigned = false;
  let discordRuntimeAssigned = false;
  for (const bot of discordBotsForStartup) {
    const discordClient = primaryDiscordAssigned ? await createDiscordClient() : discord;
    primaryDiscordAssigned = true;
    const {
      bootstrapChannelMappings,
      getHelpText,
      isCommandSupportedForPlatform,
      runManagedRouteCommand,
      handleCommand,
      handleInitRepoCommand,
      handleSetPathCommand,
      handleMakeChannelCommand,
      handleBindCommand,
      handleUnbindCommand
    } = buildScopedCommandRuntime(bot, discordClient);
    const nextDiscordRuntime = buildDiscordRuntime({
      bot,
      ChannelType: DISCORD_CHANNEL_TYPES,
      MessageFlags: DISCORD_MESSAGE_FLAGS,
      discord: discordClient,
      config,
      generalChannelId: String(bot.settings?.generalChannelId ?? "").trim() || generalChannelId,
      generalChannelName,
      generalChannelCwd: String(bot.settings?.generalCwd ?? "").trim() || generalChannelCwd,
      getChannelSetups,
      projectsCategoryName,
      managedChannelTopicPrefix,
      runManagedRouteCommand,
      runtimeAdapters,
      getHelpText,
      isCommandSupportedForPlatform,
      handleCommand,
      handleInitRepoCommand,
      handleSetPathCommand,
      handleMakeChannelCommand,
      handleBindCommand,
      handleUnbindCommand,
      approvalButtonPrefix,
      pendingApprovals,
      safeReply
    });
    if (!discordRuntimeAssigned) {
      discordRuntime = nextDiscordRuntime;
      discordRuntimeAssigned = true;
      primaryBootstrapChannelMappings = bootstrapChannelMappings ?? primaryBootstrapChannelMappings;
    }
    platforms.push(
      createDiscordPlatform({
        bot,
        discord: discordClient,
        discordToken: bot.auth.token,
        waitForDiscordReady,
        runtime: nextDiscordRuntime,
        bootstrapChannelMappings
      })
    );
  }

  for (const bot of feishuBotsForStartup) {
    const {
      getHelpText,
      isCommandSupportedForPlatform,
      runManagedRouteCommand,
      handleCommand,
      handleSetPathCommand
    } = buildScopedCommandRuntime(bot);
    const nextFeishuRuntime = buildFeishuRuntime({
      bot,
      config,
      runtimeEnv: buildBotRuntimeEnv(runtimeEnv, bot, {
        feishuEnabled,
        feishuAppId,
        feishuAppSecret,
        feishuVerificationToken,
        feishuTransport,
        feishuPort,
        feishuHost,
        feishuWebhookPath,
        imageCacheDir,
        feishuGeneralChatId,
        feishuGeneralCwd,
        feishuUnboundChatMode,
        feishuUnboundChatCwd,
        feishuRequireMentionInGroup,
        feishuSegmentedStreaming,
        feishuStreamMinChars,
        feishuEventDedupeTtlMs,
        feishuEventDedupePath
      }),
      getChannelSetups,
      runManagedRouteCommand,
      getHelpText,
      isCommandSupportedForPlatform,
      handleCommand,
      handleSetPathCommand,
      runtimeAdapters,
      safeReply
    });
    if (!feishuRuntime.enabled) {
      feishuRuntime = nextFeishuRuntime;
    }
    platforms.push(
      createFeishuPlatform({
        bot,
        runtime: nextFeishuRuntime
      })
    );
  }

  platformRegistry = createPlatformRegistry(platforms);

  const backendRuntime = buildBackendRuntime({
    enabled: backendHttpEnabled,
    host: backendHttpHost,
    port: backendHttpPort,
    processStartedAt,
    activeTurns,
    pendingApprovals,
    getMappedChannelCount: () => Object.keys(getChannelSetups()).length,
    platformRegistry
  });

  return {
    bootstrapChannelMappings: primaryBootstrapChannelMappings,
    registerSlashCommands: discordRuntime.registerSlashCommands,
    backendRuntime,
    platformRegistry,
    feishuRuntime,
    notificationRuntime,
    serverRequestRuntime,
    discordRuntime
  };
}

function listConfiguredBots(config) {
  return Object.entries(config?.bots ?? {}).map(([botId, bot]) => ({
    botId,
    ...(bot && typeof bot === "object" ? bot : {})
  }));
}

function buildBotRuntimeEnv(runtimeEnv, bot, fallback) {
  return {
    ...runtimeEnv,
    ...fallback,
    feishuEnabled: true,
    feishuAppId: String(bot?.auth?.appId ?? "").trim() || fallback.feishuAppId,
    feishuAppSecret: String(bot?.auth?.appSecret ?? "").trim() || fallback.feishuAppSecret,
    feishuVerificationToken:
      String(bot?.auth?.verificationToken ?? "").trim() || fallback.feishuVerificationToken,
    feishuTransport: String(bot?.settings?.transport ?? "").trim() || fallback.feishuTransport,
    feishuWebhookPath: String(bot?.settings?.webhookPath ?? "").trim() || fallback.feishuWebhookPath,
    feishuGeneralChatId: String(bot?.settings?.generalChatId ?? "").trim() || fallback.feishuGeneralChatId,
    feishuGeneralCwd: String(bot?.settings?.generalCwd ?? "").trim() || fallback.feishuGeneralCwd
  };
}

function createDisabledDiscordRuntime() {
  return {
    handleMessage: async () => {},
    handleInteraction: async () => {},
    handleChannelCreate: async () => {},
    registerSlashCommands: async () => null
  };
}

function createDisabledFeishuRuntime({ feishuTransport = null, feishuWebhookPath = "" } = {}) {
  return {
    enabled: false,
    transport: feishuTransport,
    webhookPath: feishuWebhookPath,
    fetchChannelByRouteId: async () => null,
    handleHttpRequest: async () => {},
    start: async () => ({ started: false }),
    stop: async () => ({ platformId: "feishu", stopped: false })
  };
}
