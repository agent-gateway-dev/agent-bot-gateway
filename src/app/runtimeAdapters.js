export function createRuntimeAdapters(deps) {
  const {
    attachmentInputBuilder,
    getTurnRunner,
    getNotificationRuntime,
    getServerRequestRuntime,
    getDiscordRuntime,
    getRuntimeOps,
    getDiscord,
    maybeSendAttachmentsForItemFromService,
    maybeSendInferredAttachmentsFromTextFromService,
    sendChunkedToChannelFromRenderer,
    attachmentConfig,
    channelMessagingConfig
  } = deps;

  function startHeartbeatLoop() {
    getRuntimeOps()?.startHeartbeatLoop();
  }

  async function writeHeartbeatFile() {
    await getRuntimeOps()?.writeHeartbeatFile();
  }

  async function requestSelfRestartFromDiscord(message, reason) {
    await getRuntimeOps()?.requestSelfRestartFromDiscord(message, reason);
  }

  async function maybeCompletePendingRestartNotice() {
    await getRuntimeOps()?.maybeCompletePendingRestartNotice(getDiscord());
  }

  function shouldHandleAsSelfRestartRequest(content) {
    return getRuntimeOps()?.shouldHandleAsSelfRestartRequest(content) ?? false;
  }

  async function handleMessage(message) {
    await getDiscordRuntime()?.handleMessage(message);
  }

  async function handleInteraction(interaction) {
    await getDiscordRuntime()?.handleInteraction(interaction);
  }

  function collectImageAttachments(message) {
    return attachmentInputBuilder.collectImageAttachments(message);
  }

  async function buildTurnInputFromMessage(message, text, imageAttachments, setup = null) {
    return await attachmentInputBuilder.buildTurnInputFromMessage(message, text, imageAttachments, setup);
  }

  function enqueuePrompt(repoChannelId, job) {
    getTurnRunner()?.enqueuePrompt(repoChannelId, job);
  }

  function getQueue(repoChannelId) {
    return getTurnRunner()?.getQueue(repoChannelId);
  }

  async function handleNotification({ method, params }) {
    await getNotificationRuntime()?.handleNotification({ method, params });
  }

  function onTurnReconnectPending(threadId, context = {}) {
    getNotificationRuntime()?.onTurnReconnectPending(threadId, context);
  }

  async function handleServerRequest({ id, method, params }) {
    await getServerRequestRuntime()?.handleServerRequest({ id, method, params });
  }

  function findLatestPendingApprovalTokenForChannel(repoChannelId) {
    return getServerRequestRuntime()?.findLatestPendingApprovalTokenForChannel(repoChannelId) ?? null;
  }

  async function applyApprovalDecision(token, decision, actorMention) {
    return (
      (await getServerRequestRuntime()?.applyApprovalDecision(token, decision, actorMention)) ?? {
        ok: false,
        error: "Approval runtime unavailable"
      }
    );
  }

  function findActiveTurnByRepoChannel(repoChannelId) {
    return getTurnRunner()?.findActiveTurnByRepoChannel(repoChannelId);
  }

  async function finalizeTurn(threadId, error) {
    await getNotificationRuntime()?.finalizeTurn(threadId, error);
  }

  async function maybeSendAttachmentsForItem(tracker, item) {
    const maxAttachmentIssueMessages = tracker?.allowFileWrites === false ? 0 : attachmentConfig.attachmentIssueLimitPerTurn;
    await maybeSendAttachmentsForItemFromService(tracker, item, {
      attachmentsEnabled: attachmentConfig.attachmentsEnabled,
      attachmentItemTypes: attachmentConfig.attachmentItemTypes,
      attachmentMaxBytes: attachmentConfig.attachmentMaxBytes,
      attachmentRoots: attachmentConfig.attachmentRoots,
      imageCacheDir: attachmentConfig.imageCacheDir,
      attachmentInferFromText: attachmentConfig.attachmentInferFromText,
      statusLabelForItemType: channelMessagingConfig.statusLabelForItemType,
      safeSendToChannel: channelMessagingConfig.safeSendToChannel,
      safeSendToChannelPayload: channelMessagingConfig.safeSendToChannelPayload,
      truncateStatusText: channelMessagingConfig.truncateStatusText,
      maxAttachmentIssueMessages
    });
  }

  async function maybeSendInferredAttachmentsFromText(tracker, text) {
    return (
      (await maybeSendInferredAttachmentsFromTextFromService(tracker, text, {
        attachmentsEnabled: attachmentConfig.attachmentsEnabled,
        attachmentMaxBytes: attachmentConfig.attachmentMaxBytes,
        attachmentRoots: attachmentConfig.attachmentRoots,
        imageCacheDir: attachmentConfig.imageCacheDir,
        statusLabelForItemType: channelMessagingConfig.statusLabelForItemType,
        safeSendToChannel: channelMessagingConfig.safeSendToChannel,
        safeSendToChannelPayload: channelMessagingConfig.safeSendToChannelPayload,
        truncateStatusText: channelMessagingConfig.truncateStatusText
      })) ?? 0
    );
  }

  async function sendChunkedToChannel(channel, text) {
    await sendChunkedToChannelFromRenderer(
      channel,
      text,
      channelMessagingConfig.safeSendToChannel,
      channelMessagingConfig.discordMaxMessageLength
    );
  }

  return {
    startHeartbeatLoop,
    writeHeartbeatFile,
    requestSelfRestartFromDiscord,
    maybeCompletePendingRestartNotice,
    shouldHandleAsSelfRestartRequest,
    handleMessage,
    handleInteraction,
    collectImageAttachments,
    buildTurnInputFromMessage,
    enqueuePrompt,
    getQueue,
    handleNotification,
    onTurnReconnectPending,
    handleServerRequest,
    findLatestPendingApprovalTokenForChannel,
    applyApprovalDecision,
    findActiveTurnByRepoChannel,
    finalizeTurn,
    maybeSendAttachmentsForItem,
    maybeSendInferredAttachmentsFromText,
    sendChunkedToChannel
  };
}
