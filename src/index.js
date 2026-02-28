import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dotenv from "dotenv";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageFlags
} from "discord.js";
import { CodexRpcClient } from "./codexRpcClient.js";
import { maybeSendAttachmentsForItem as maybeSendAttachmentsForItemFromService } from "./attachments/service.js";
import { createAttachmentInputBuilder } from "./attachments/inputBuilder.js";
import { createRuntimeOps } from "./app/runtimeOps.js";
import { createDiscordRuntime } from "./app/discordRuntime.js";
import { createChannelMessaging } from "./app/channelMessaging.js";
import { createServerRequestRuntime } from "./approvals/serverRequestRuntime.js";
import { createBootstrapService } from "./channels/bootstrapService.js";
import { resolveRepoContext, isGeneralChannel } from "./channels/context.js";
import { createCommandRouter } from "./commands/router.js";
import { loadConfig, parseAttachmentItemTypes, parsePathListEnv } from "./config/loadConfig.js";
import {
  buildApprovalActionRows,
  buildResponseForServerRequest,
  describeToolRequestUserInput,
  parseApprovalButtonCustomId
} from "./codex/approvalPayloads.js";
import { normalizeCodexNotification } from "./codex/notificationMapper.js";
import {
  extractAgentMessageText,
  extractThreadId,
  isThreadNotFoundError,
  isTransientReconnectErrorMessage
} from "./codex/eventUtils.js";
import { createSandboxPolicyResolver } from "./codex/sandboxPolicy.js";
import { createTurnRunner } from "./codex/turnRunner.js";
import {
  buildTurnRenderPlan,
  normalizeRenderVerbosity,
  sendChunkedToChannel as sendChunkedToChannelFromRenderer,
  truncateForDiscordMessage
} from "./render/messageRenderer.js";
import { StateStore } from "./stateStore.js";
import { TURN_PHASE, transitionTurnPhase } from "./turns/lifecycle.js";
import { createNotificationRuntime } from "./turns/notificationRuntime.js";
import { createTurnRecoveryStore } from "./turns/recoveryStore.js";
import {
  buildFileDiffSection,
  extractWebSearchDetails,
  recordFileChanges,
  statusLabelForItemType,
  summarizeItemForStatus,
  truncateStatusText
} from "./turns/turnFormatting.js";
import { normalizeFinalSummaryText } from "./turns/textNormalization.js";

dotenv.config();

const discordToken = process.env.DISCORD_BOT_TOKEN;
if (!discordToken) {
  console.error("Missing DISCORD_BOT_TOKEN");
  process.exit(1);
}

const configPath = path.resolve(process.env.CHANNEL_CONFIG_PATH ?? "config/channels.json");
const statePath = path.resolve(process.env.STATE_PATH ?? "data/state.json");
const codexBin = process.env.CODEX_BIN ?? "codex";
const codexHomeEnv = process.env.CODEX_HOME;
const repoRootEnv = process.env.DISCORD_REPO_ROOT;
const repoRootPath = repoRootEnv ? path.resolve(repoRootEnv) : null;
const managedChannelTopicPrefix = "codex-cwd:";
const managedThreadTopicPrefix = "codex-thread:";
const approvalButtonPrefix = "approval:";
const generalChannelId = String(process.env.DISCORD_GENERAL_CHANNEL_ID ?? "").trim();
const generalChannelName = String(process.env.DISCORD_GENERAL_CHANNEL_NAME ?? "general")
  .trim()
  .toLowerCase();
const generalChannelDefaultCwd = path.join(os.tmpdir(), "codex-discord-bridge", "general");
const generalChannelCwd = path.resolve(process.env.DISCORD_GENERAL_CWD ?? generalChannelDefaultCwd);
const imageCacheDir = path.resolve(process.env.DISCORD_IMAGE_CACHE_DIR ?? "/tmp/codex-discord-bridge-images");
const configuredMaxImages = Number(process.env.DISCORD_MAX_IMAGES_PER_MESSAGE ?? 4);
const maxImagesPerMessage =
  Number.isFinite(configuredMaxImages) && configuredMaxImages > 0 ? Math.floor(configuredMaxImages) : 4;
const configuredAttachmentMaxBytes = Number(process.env.DISCORD_ATTACHMENT_MAX_BYTES ?? "");
const attachmentMaxBytes =
  Number.isFinite(configuredAttachmentMaxBytes) && configuredAttachmentMaxBytes > 0
    ? Math.floor(configuredAttachmentMaxBytes)
    : 8 * 1024 * 1024;
const attachmentRoots = parsePathListEnv(process.env.DISCORD_ATTACHMENT_ROOTS);
const attachmentInferFromText = process.env.DISCORD_ATTACHMENT_INFER_FROM_TEXT === "1";
const attachmentsEnabled = process.env.DISCORD_ENABLE_ATTACHMENTS !== "0";
const attachmentItemTypes = parseAttachmentItemTypes(process.env.DISCORD_ATTACHMENT_ITEM_TYPES);
const configuredAttachmentIssueLimit = Number(process.env.DISCORD_MAX_ATTACHMENT_ISSUES_PER_TURN ?? "");
const attachmentIssueLimitPerTurn =
  Number.isFinite(configuredAttachmentIssueLimit) && configuredAttachmentIssueLimit >= 0
    ? Math.floor(configuredAttachmentIssueLimit)
    : 1;
const renderVerbosity = normalizeRenderVerbosity(process.env.DISCORD_RENDER_VERBOSITY);
const heartbeatPath = path.resolve(process.env.DISCORD_HEARTBEAT_PATH ?? "data/bridge-heartbeat.json");
const restartRequestPath = path.resolve(process.env.DISCORD_RESTART_REQUEST_PATH ?? "data/restart-request.json");
const restartAckPath = path.resolve(process.env.DISCORD_RESTART_ACK_PATH ?? "data/restart-ack.json");
const restartNoticePath = path.resolve(
  process.env.DISCORD_RESTART_NOTICE_PATH ?? "data/restart-discord-notice.json"
);
const inFlightRecoveryPath = path.resolve(process.env.DISCORD_INFLIGHT_RECOVERY_PATH ?? "data/inflight-turns.json");
const exitOnRestartAck = process.env.DISCORD_EXIT_ON_RESTART_ACK === "1";
const configuredHeartbeatIntervalMs = Number(process.env.DISCORD_HEARTBEAT_INTERVAL_MS ?? "");
const heartbeatIntervalMs =
  Number.isFinite(configuredHeartbeatIntervalMs) && configuredHeartbeatIntervalMs >= 5_000
    ? Math.floor(configuredHeartbeatIntervalMs)
    : 30_000;
const debugLoggingEnabled = process.env.DISCORD_DEBUG_LOGGING === "1";
const projectsCategoryName =
  process.env.DISCORD_PROJECTS_CATEGORY_NAME ??
  process.env.DISCORD_LEGACY_CATEGORY_NAME ??
  "codex-projects";
const discordMaxMessageLength = 1900;
const execFileAsync = promisify(execFile);
const extraWritableRoots = parsePathListEnv(process.env.CODEX_EXTRA_WRITABLE_ROOTS);
const defaultModel = "gpt-5.3-codex";
const defaultEffort = "medium";

const config = await loadConfig(configPath, { defaultModel, defaultEffort });
let channelSetups = { ...config.channels };
const state = new StateStore(statePath);
await state.load();
const legacyThreadsDropped = state.consumeLegacyDropCount();
if (legacyThreadsDropped > 0) {
  console.warn(`Cutover: dropped ${legacyThreadsDropped} legacy channel thread bindings from state.`);
  await state.save();
}

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
const codex = new CodexRpcClient({
  codexBin
});
const channelMessaging = createChannelMessaging({ discord });
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
let nextApprovalToken = 1;
const processStartedAt = new Date().toISOString();
let shuttingDown = false;
let runtimeOps = null;
let discordRuntime = null;
let notificationRuntime = null;
let serverRequestRuntime = null;
const turnRunner = createTurnRunner({
  queues,
  activeTurns,
  state,
  codex,
  config,
  safeReply,
  buildSandboxPolicyForTurn,
  isThreadNotFoundError,
  finalizeTurn,
  onTurnReconnectPending,
  onTurnCreated: async (tracker) => {
    await turnRecoveryStore.upsertTurnFromTracker(tracker);
  },
  onTurnAborted: async (threadId) => {
    await turnRecoveryStore.removeTurn(threadId);
  },
  onActiveTurnsChanged: () => runtimeOps?.writeHeartbeatFile()
});
const attachmentInputBuilder = createAttachmentInputBuilder({
  fs,
  imageCacheDir,
  maxImagesPerMessage,
  discordToken,
  fetch,
  formatInputTextForSetup,
  logger: console
});

codex.on("stderr", (line) => {
  console.error(`[codex] ${line}`);
});
codex.on("notification", (event) => {
  void handleNotification(event);
});
codex.on("serverRequest", (request) => {
  void handleServerRequest(request);
});
codex.on("exit", ({ code, signal }) => {
  console.error(`codex app-server exited (code=${code}, signal=${signal ?? "none"})`);
});
codex.on("error", (error) => {
  console.error(`codex app-server error: ${error.message}`);
});

discord.on("clientReady", () => {
  console.log(`Discord connected as ${discord.user?.tag}`);
});

discord.on("messageCreate", (message) => {
  void handleMessage(message).catch((error) => {
    console.error(`message handler failed in channel ${message.channelId}: ${error.message}`);
  });
});
discord.on("interactionCreate", (interaction) => {
  void handleInteraction(interaction).catch((error) => {
    console.error(`interaction handler failed: ${error.message}`);
  });
});

runtimeOps = createRuntimeOps({
  fs,
  path,
  debugLog,
  activeTurns,
  pendingApprovals,
  heartbeatPath,
  restartRequestPath,
  restartAckPath,
  restartNoticePath,
  processStartedAt,
  heartbeatIntervalMs,
  exitOnRestartAck,
  safeReply,
  safeSendToChannel,
  truncateStatusText,
  shutdown
});

const bootstrapService = createBootstrapService({
  ChannelType,
  path,
  discord,
  codex,
  config,
  state,
  projectsCategoryName,
  managedChannelTopicPrefix,
  managedThreadTopicPrefix,
  isDiscordMissingPermissionsError,
  getChannelSetups: () => channelSetups,
  setChannelSetups: (next) => {
    channelSetups = next;
  }
});
const { bootstrapChannelMappings, makeChannelName } = bootstrapService;
const commandRouter = createCommandRouter({
  ChannelType,
  isGeneralChannel,
  fs,
  path,
  execFileAsync,
  repoRootPath,
  managedChannelTopicPrefix,
  codexBin,
  codexHomeEnv,
  statePath,
  configPath,
  config,
  state,
  codex,
  pendingApprovals,
  makeChannelName,
  collectImageAttachments,
  buildTurnInputFromMessage,
  enqueuePrompt,
  getQueue,
  findActiveTurnByRepoChannel,
  requestSelfRestartFromDiscord,
  findLatestPendingApprovalTokenForChannel,
  applyApprovalDecision,
  safeReply,
  getChannelSetups: () => channelSetups,
  setChannelSetups: (nextSetups) => {
    channelSetups = nextSetups;
  }
});
const { handleCommand, handleInitRepoCommand } = commandRouter;
notificationRuntime = createNotificationRuntime({
  activeTurns,
  renderVerbosity,
  TURN_PHASE,
  transitionTurnPhase,
  normalizeCodexNotification,
  extractAgentMessageText,
  maybeSendAttachmentsForItem,
  recordFileChanges,
  summarizeItemForStatus,
  extractWebSearchDetails,
  buildFileDiffSection,
  buildTurnRenderPlan,
  sendChunkedToChannel,
  normalizeFinalSummaryText,
  truncateStatusText,
  isTransientReconnectErrorMessage,
  safeSendToChannel,
  truncateForDiscordMessage,
  discordMaxMessageLength,
  debugLog,
  writeHeartbeatFile,
  onTurnFinalized: async (tracker) => {
    await turnRecoveryStore.removeTurn(tracker?.threadId);
  }
});
serverRequestRuntime = createServerRequestRuntime({
  codex,
  discord,
  state,
  activeTurns,
  pendingApprovals,
  approvalButtonPrefix,
  isGeneralChannel,
  extractThreadId,
  describeToolRequestUserInput,
  buildApprovalActionRows,
  buildResponseForServerRequest,
  truncateStatusText,
  truncateForDiscordMessage,
  safeSendToChannel,
  createApprovalToken: () => String(nextApprovalToken++).padStart(4, "0")
});
discordRuntime = createDiscordRuntime({
  discord,
  config,
  resolveRepoContext,
  generalChannelId,
  generalChannelName,
  generalChannelCwd,
  getChannelSetups: () => channelSetups,
  bootstrapChannelMappings,
  shouldHandleAsSelfRestartRequest,
  requestSelfRestartFromDiscord,
  collectImageAttachments,
  buildTurnInputFromMessage,
  enqueuePrompt,
  handleCommand,
  handleInitRepoCommand,
  parseApprovalButtonCustomId,
  approvalButtonPrefix,
  pendingApprovals,
  applyApprovalDecision,
  safeReply,
  MessageFlags
});

await codex.start();
await fs.mkdir(generalChannelCwd, { recursive: true }).catch((error) => {
  console.warn(`failed to ensure general cwd at ${generalChannelCwd}: ${error.message}`);
});
await discord.login(discordToken);
await discord.application?.fetch().catch(() => null);
await waitForDiscordReady(discord);
await maybeCompletePendingRestartNotice();
try {
  const recovery = await turnRecoveryStore.reconcilePending({
    discord,
    codex,
    safeSendToChannel
  });
  if (recovery.reconciled > 0) {
    console.log(
      `turn recovery complete (reconciled=${recovery.reconciled}, resumed_known=${recovery.resumedKnown}, missing_thread=${recovery.missingThread}, skipped=${recovery.skipped})`
    );
  }
} catch (error) {
  console.error(`turn recovery failed: ${error.message}`);
}
try {
  const bootstrapSummary = await bootstrapChannelMappings();
  console.log(
    `channel bootstrap complete (discovered=${bootstrapSummary.discoveredCwds}, created=${bootstrapSummary.createdChannels}, moved=${bootstrapSummary.movedChannels}, pruned=${bootstrapSummary.prunedBindings}, mapped=${Object.keys(channelSetups).length})`
  );
} catch (error) {
  console.error(`channel bootstrap failed: ${error.message}`);
}
startHeartbeatLoop();

process.on("SIGINT", () => {
  void shutdown(0);
});
process.on("SIGTERM", () => {
  void shutdown(0);
});

async function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  runtimeOps?.stopHeartbeatLoop();
  try {
    await codex.stop();
  } catch {}
  discord.destroy();
  process.exit(exitCode);
}

function startHeartbeatLoop() {
  runtimeOps?.startHeartbeatLoop();
}

async function writeHeartbeatFile() {
  await runtimeOps?.writeHeartbeatFile();
}

async function requestSelfRestartFromDiscord(message, reason) {
  await runtimeOps?.requestSelfRestartFromDiscord(message, reason);
}

async function maybeCompletePendingRestartNotice() {
  await runtimeOps?.maybeCompletePendingRestartNotice(discord);
}

function shouldHandleAsSelfRestartRequest(content) {
  return runtimeOps?.shouldHandleAsSelfRestartRequest(content) ?? false;
}

async function handleMessage(message) {
  await discordRuntime?.handleMessage(message);
}

async function handleInteraction(interaction) {
  await discordRuntime?.handleInteraction(interaction);
}

function collectImageAttachments(message) {
  return attachmentInputBuilder.collectImageAttachments(message);
}

async function buildTurnInputFromMessage(message, text, imageAttachments, setup = null) {
  return await attachmentInputBuilder.buildTurnInputFromMessage(message, text, imageAttachments, setup);
}

function formatInputTextForSetup(text, setup) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) {
    return "";
  }
  if (setup?.mode !== "general") {
    return trimmed;
  }
  return [
    "[Channel context: #general]",
    "Treat this channel as informational Q&A and general conversation.",
    "Do not assume repo work, file edits, or tool/command execution unless explicitly requested.",
    "Ignore local cwd/repo context unless the user explicitly asks for it.",
    "",
    trimmed
  ].join("\n");
}

function waitForDiscordReady(client) {
  if (client.isReady()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    client.once("clientReady", () => resolve());
  });
}

function isDiscordMissingPermissionsError(error) {
  return (
    Number(error?.code) === 50013 ||
    Number(error?.rawError?.code) === 50013 ||
    String(error?.message ?? "").toLowerCase().includes("missing permissions")
  );
}

function debugLog(scope, message, details) {
  if (!debugLoggingEnabled) {
    return;
  }
  if (details === undefined) {
    console.log(`[debug:${scope}] ${message}`);
    return;
  }
  let serialized = "";
  try {
    serialized = JSON.stringify(details);
  } catch {
    serialized = String(details);
  }
  const trimmed = serialized.length > 1200 ? `${serialized.slice(0, 1200)}...` : serialized;
  console.log(`[debug:${scope}] ${message} ${trimmed}`);
}

function enqueuePrompt(repoChannelId, job) {
  turnRunner.enqueuePrompt(repoChannelId, job);
}

function getQueue(repoChannelId) {
  return turnRunner.getQueue(repoChannelId);
}

async function handleNotification({ method, params }) {
  await notificationRuntime?.handleNotification({ method, params });
}

function onTurnReconnectPending(threadId, context = {}) {
  notificationRuntime?.onTurnReconnectPending(threadId, context);
}

async function handleServerRequest({ id, method, params }) {
  await serverRequestRuntime?.handleServerRequest({ id, method, params });
}

function findLatestPendingApprovalTokenForChannel(repoChannelId) {
  return serverRequestRuntime?.findLatestPendingApprovalTokenForChannel(repoChannelId) ?? null;
}

async function applyApprovalDecision(token, decision, actorMention) {
  return (
    (await serverRequestRuntime?.applyApprovalDecision(token, decision, actorMention)) ?? {
      ok: false,
      error: "Approval runtime unavailable"
    }
  );
}

function findActiveTurnByRepoChannel(repoChannelId) {
  return turnRunner.findActiveTurnByRepoChannel(repoChannelId);
}

async function finalizeTurn(threadId, error) {
  await notificationRuntime?.finalizeTurn(threadId, error);
}

async function maybeSendAttachmentsForItem(tracker, item) {
  const maxAttachmentIssueMessages = tracker?.allowFileWrites === false ? 0 : attachmentIssueLimitPerTurn;
  await maybeSendAttachmentsForItemFromService(tracker, item, {
    attachmentsEnabled,
    attachmentItemTypes,
    attachmentMaxBytes,
    attachmentRoots,
    imageCacheDir,
    attachmentInferFromText,
    statusLabelForItemType,
    safeSendToChannel,
    safeSendToChannelPayload,
    truncateStatusText,
    maxAttachmentIssueMessages
  });
}

async function sendChunkedToChannel(channel, text) {
  await sendChunkedToChannelFromRenderer(channel, text, safeSendToChannel, discordMaxMessageLength);
}
