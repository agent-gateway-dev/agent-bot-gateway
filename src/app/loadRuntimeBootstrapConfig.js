import process from "node:process";
import dotenv from "dotenv";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../config/loadConfig.js";
import { loadRuntimeEnv } from "../config/runtimeEnv.js";
import { StateStore } from "../stateStore.js";
import { createDebugLog } from "./runtimeUtils.js";

export async function loadRuntimeBootstrapConfig() {
  dotenv.config();

  const discordToken = String(process.env.DISCORD_BOT_TOKEN ?? "").trim() || null;
  const feishuEnabled = Boolean(
    String(process.env.FEISHU_APP_ID ?? "").trim() && String(process.env.FEISHU_APP_SECRET ?? "").trim()
  );
  if (!discordToken && !feishuEnabled) {
    console.error("Missing chat platform credentials. Set DISCORD_BOT_TOKEN or FEISHU_APP_ID + FEISHU_APP_SECRET.");
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
  let channelSetups = { ...config.channels };
  const state = new StateStore(statePath);
  await state.load();
  const legacyThreadsDropped = state.consumeLegacyDropCount();
  if (legacyThreadsDropped > 0) {
    console.warn(`Cutover: dropped ${legacyThreadsDropped} legacy channel thread bindings from state.`);
    await state.save();
  }

  return {
    runtimeEnv,
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
