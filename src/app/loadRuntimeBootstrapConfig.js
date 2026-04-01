import process from "node:process";
import dotenv from "dotenv";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../config/loadConfig.js";
import { enforceOperationalConfig } from "../config/governance.js";
import { loadRuntimeEnv } from "../config/runtimeEnv.js";
import { StateStore } from "../stateStore.js";
import { createDebugLog } from "./runtimeUtils.js";

export async function loadRuntimeBootstrapConfig() {
  dotenv.config();

  try {
    enforceOperationalConfig(process.env);
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(1);
  }

  const runtimeEnv = loadRuntimeEnv();
  const { configPath, statePath, debugLoggingEnabled, discordMessageChunkLimit, feishuMessageChunkLimit } = runtimeEnv;
  const execFileAsync = promisify(execFile);
  const defaultModel = "gpt-5.3-codex";
  const defaultEffort = "medium";
  const debugLog = createDebugLog(debugLoggingEnabled);
  const discordMaxMessageLength = discordMessageChunkLimit;
  const feishuMaxMessageLength = feishuMessageChunkLimit;

  const config = await loadConfig(configPath, { defaultModel, defaultEffort });
  const materializedBots = materializeBots(config.bots, process.env);
  const resolvedBots =
    Object.keys(materializedBots).length > 0 ? materializedBots : synthesizeLegacyEnvBots(config.runtime, process.env);
  const primaryDiscordBot = findFirstBotByPlatform(resolvedBots, "discord");
  const primaryFeishuBot = findFirstBotByPlatform(resolvedBots, "feishu");
  const discordToken = String(primaryDiscordBot?.auth?.token ?? "").trim() || null;
  const feishuEnabled = Boolean(
    String(primaryFeishuBot?.auth?.appId ?? "").trim() && String(primaryFeishuBot?.auth?.appSecret ?? "").trim()
  );
  if (!discordToken && !feishuEnabled) {
    console.error("Missing chat platform credentials. Set DISCORD_BOT_TOKEN or FEISHU_APP_ID + FEISHU_APP_SECRET.");
    process.exit(1);
  }

  config.bots = resolvedBots;
  let channelSetups = { ...config.channels };
  const state = new StateStore(statePath, { bots: config.bots });
  await state.load();
  const legacyThreadsDropped = state.consumeLegacyDropCount();
  if (legacyThreadsDropped > 0) {
    console.warn(`Cutover: dropped ${legacyThreadsDropped} legacy channel thread bindings from state.`);
    await state.save();
  }

  return {
    runtimeEnv: hydrateRuntimeEnv(runtimeEnv, primaryDiscordBot, primaryFeishuBot),
    discordToken,
    execFileAsync,
    debugLog,
    discordMaxMessageLength,
    feishuMaxMessageLength,
    config,
    state,
    getChannelSetups: () => channelSetups,
    setChannelSetups: (nextSetups) => {
      channelSetups = nextSetups;
    }
  };
}

function materializeBots(bots, env) {
  const normalizedBots = bots && typeof bots === "object" && !Array.isArray(bots) ? bots : {};
  const materializedBots = {};

  for (const [botId, bot] of Object.entries(normalizedBots)) {
    const materializedBot = materializeBot(botId, bot, env);
    materializedBots[botId] = materializedBot;
  }

  return materializedBots;
}

function materializeBot(botId, bot, env) {
  const normalizedBot = bot && typeof bot === "object" && !Array.isArray(bot) ? bot : {};
  const platform = String(normalizedBot.platform ?? "").trim().toLowerCase();
  const auth = normalizedBot.auth && typeof normalizedBot.auth === "object" && !Array.isArray(normalizedBot.auth)
    ? { ...normalizedBot.auth }
    : {};

  if (platform === "discord") {
    const token = resolveCredential(auth.tokenEnv, auth.token, env);
    if (!token) {
      throw new Error(`Bot ${botId} is missing Discord token from ${String(auth.tokenEnv ?? "auth.tokenEnv")}.`);
    }
    return {
      ...normalizedBot,
      auth: {
        ...auth,
        token
      }
    };
  }

  if (platform === "feishu") {
    const appId = resolveCredential(auth.appIdEnv, auth.appId, env);
    const appSecret = resolveCredential(auth.appSecretEnv, auth.appSecret, env);
    if (!appId || !appSecret) {
      throw new Error(`Bot ${botId} is missing Feishu app credentials from auth.appIdEnv/appSecretEnv.`);
    }
    const verificationToken = resolveCredential(auth.verificationTokenEnv, auth.verificationToken, env);
    return {
      ...normalizedBot,
      auth: {
        ...auth,
        appId,
        appSecret,
        ...(verificationToken ? { verificationToken } : {})
      }
    };
  }

  return {
    ...normalizedBot,
    auth
  };
}

function synthesizeLegacyEnvBots(runtime, env) {
  const bots = {};
  const discordToken = String(env.DISCORD_BOT_TOKEN ?? "").trim();
  const feishuAppId = String(env.FEISHU_APP_ID ?? "").trim();
  const feishuAppSecret = String(env.FEISHU_APP_SECRET ?? "").trim();
  const feishuVerificationToken = String(env.FEISHU_VERIFICATION_TOKEN ?? "").trim();

  if (discordToken) {
    bots["discord-default"] = {
      platform: "discord",
      runtime: runtime || "codex",
      auth: {
        tokenEnv: "DISCORD_BOT_TOKEN",
        token: discordToken
      },
      settings: {
        allowedUserIdsEnv: "DISCORD_ALLOWED_USER_IDS"
      },
      routes: {}
    };
  }

  if (feishuAppId && feishuAppSecret) {
    bots["feishu-default"] = {
      platform: "feishu",
      runtime: runtime || "codex",
      auth: {
        appIdEnv: "FEISHU_APP_ID",
        appSecretEnv: "FEISHU_APP_SECRET",
        appId: feishuAppId,
        appSecret: feishuAppSecret,
        ...(feishuVerificationToken ? { verificationTokenEnv: "FEISHU_VERIFICATION_TOKEN", verificationToken: feishuVerificationToken } : {})
      },
      settings: {
        allowedOpenIdsEnv: "FEISHU_ALLOWED_OPEN_IDS"
      },
      routes: {}
    };
  }

  return bots;
}

function resolveCredential(envName, fallbackValue, env) {
  const normalizedEnvName = String(envName ?? "").trim();
  if (normalizedEnvName) {
    return String(env[normalizedEnvName] ?? "").trim();
  }
  return String(fallbackValue ?? "").trim();
}

function findFirstBotByPlatform(bots, platform) {
  return Object.values(bots ?? {}).find((bot) => String(bot?.platform ?? "").trim().toLowerCase() === platform) ?? null;
}

function hydrateRuntimeEnv(runtimeEnv, primaryDiscordBot, primaryFeishuBot) {
  return {
    ...runtimeEnv,
    generalChannelId:
      String(primaryDiscordBot?.settings?.generalChannelId ?? "").trim() || runtimeEnv.generalChannelId,
    ...(primaryFeishuBot
      ? {
          feishuEnabled: true,
          feishuAppId: String(primaryFeishuBot.auth?.appId ?? "").trim(),
          feishuAppSecret: String(primaryFeishuBot.auth?.appSecret ?? "").trim(),
          feishuVerificationToken:
            String(primaryFeishuBot.auth?.verificationToken ?? "").trim() || runtimeEnv.feishuVerificationToken,
          feishuTransport: String(primaryFeishuBot.settings?.transport ?? "").trim() || runtimeEnv.feishuTransport,
          feishuWebhookPath:
            String(primaryFeishuBot.settings?.webhookPath ?? "").trim() || runtimeEnv.feishuWebhookPath,
          feishuGeneralChatId:
            String(primaryFeishuBot.settings?.generalChatId ?? "").trim() || runtimeEnv.feishuGeneralChatId
        }
      : null)
  };
}
