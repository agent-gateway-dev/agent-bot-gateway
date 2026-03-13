export function createDiscordRuntime(deps) {
  const {
    discord,
    config,
    resolveRepoContext,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
    getChannelSetups,
    runManagedRouteCommand,
    shouldHandleAsSelfRestartRequest,
    requestSelfRestartFromDiscord,
    collectImageAttachments,
    buildTurnInputFromMessage,
    enqueuePrompt,
    getHelpText,
    handleCommand,
    handleInitRepoCommand,
    handleSetPathCommand,
    isCommandSupportedForPlatform,
    buildCommandTextFromInteraction,
    registerSlashCommands,
    parseApprovalButtonCustomId,
    approvalButtonPrefix,
    pendingApprovals,
    applyApprovalDecision,
    safeReply,
    MessageFlags
  } = deps;

  async function handleMessage(message) {
    if (message.author.bot) {
      return;
    }

    const rawContent = message.content.trim();
    if (!isAllowedUser(message.author.id)) {
      console.warn(`ignoring message from filtered user ${message.author.id} in channel ${message.channelId}`);
      return;
    }

    const imageAttachments = collectImageAttachments(message);
    if (!rawContent && imageAttachments.length === 0) {
      return;
    }

    const content = normalizeIncomingContent(rawContent, discord.user?.id);
    if (!content && imageAttachments.length === 0) {
      return;
    }

    if (content.toLowerCase() === "!resync") {
      await runManagedRouteCommand(message, { forceRebuild: false });
      return;
    }

    if (content.toLowerCase() === "!rebuild") {
      await runManagedRouteCommand(message, { forceRebuild: true });
      return;
    }

    const context = resolveRepoContext(message, {
      channelSetups: getChannelSetups(),
      config,
      generalChannel: {
        id: generalChannelId,
        name: generalChannelName,
        cwd: generalChannelCwd
      }
    });
    if (content.startsWith("!")) {
      const [commandRaw, ...restParts] = content.split(/\s+/);
      const command = commandRaw.toLowerCase();
      const rest = restParts.join(" ").trim();

      if (command === "!initrepo") {
        await handleInitRepoCommand(message, rest);
        return;
      }
      if (command === "!setpath") {
        await handleSetPathCommand(message, rest);
        return;
      }
    }

    if (!context) {
      return;
    }

    if (content.startsWith("!")) {
      await handleCommand(message, content, context);
      return;
    }

    if (shouldHandleAsSelfRestartRequest(content)) {
      await requestSelfRestartFromDiscord(message, content);
      return;
    }

    const inputItems = await buildTurnInputFromMessage(message, content, imageAttachments, context.setup);
    if (inputItems.length === 0) {
      return;
    }
    enqueuePrompt(context.repoChannelId, {
      inputItems,
      message,
      setup: context.setup,
      repoChannelId: context.repoChannelId
    });
  }

  async function handleInteraction(interaction) {
    if (interaction.isButton()) {
      await handleApprovalButtonInteraction(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (!isAllowedUser(interaction.user.id)) {
      await interaction.reply({
        content: "You are not allowed to use this bot.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.deferReply();
    const commandText = buildCommandTextFromInteraction(interaction);
    if (!commandText) {
      await interaction.editReply("Unknown slash command.");
      return;
    }

    const message = createInteractionMessageAdapter(interaction);
    if (interaction.commandName === "help") {
      await safeReply(message, getHelpText({ platformId: "discord" }));
      return;
    }

    if (interaction.commandName === "resync") {
      await runManagedRouteCommand(message, { forceRebuild: false });
      return;
    }

    if (interaction.commandName === "rebuild") {
      await runManagedRouteCommand(message, { forceRebuild: true });
      return;
    }

    if (interaction.commandName === "initrepo") {
      if (isCommandSupportedForPlatform && !isCommandSupportedForPlatform("initrepo", "discord")) {
        await safeReply(message, "This platform does not support `initrepo`.");
        return;
      }
      const rest = commandText.replace(/^!initrepo\b/i, "").trim();
      await handleInitRepoCommand(message, rest);
      return;
    }

    if (interaction.commandName === "setpath") {
      const rest = commandText.replace(/^!setpath\b/i, "").trim();
      await handleSetPathCommand(message, rest);
      return;
    }

    const context = resolveRepoContext(message, {
      channelSetups: getChannelSetups(),
      config,
      generalChannel: {
        id: generalChannelId,
        name: generalChannelName,
        cwd: generalChannelCwd
      }
    });
    if (!context) {
      await safeReply(message, "This command only works in a managed repo channel or the configured #general channel.");
      return;
    }

    await handleCommand(message, commandText, context);
  }

  async function handleApprovalButtonInteraction(interaction) {
    const parsed = parseApprovalButtonCustomId(interaction.customId, approvalButtonPrefix);
    if (!parsed) {
      return;
    }

    if (!isAllowedUser(interaction.user.id)) {
      await interaction.reply({
        content: "You are not allowed to approve requests for this bot.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const approval = pendingApprovals.get(parsed.token);
    if (!approval) {
      await interaction.reply({ content: "That approval is already resolved.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (approval.repoChannelId !== interaction.channelId) {
      await interaction.reply({
        content: "That approval belongs to a different channel.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const result = await applyApprovalDecision(parsed.token, parsed.decision, `<@${interaction.user.id}>`);
    if (!result.ok) {
      await interaction.reply({
        content: `Failed to send approval response: ${result.error}`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await interaction.reply({
      content: `${parsed.decision} sent for approval \`${parsed.token}\`.`,
      flags: MessageFlags.Ephemeral
    });
  }

  function isAllowedUser(userId) {
    if (!Array.isArray(config.allowedUserIds) || config.allowedUserIds.length === 0) {
      return true;
    }
    return config.allowedUserIds.includes(userId);
  }

  return {
    handleMessage,
    handleInteraction,
    registerSlashCommands
  };
}

function normalizeIncomingContent(content, botUserId) {
  if (!content) {
    return "";
  }
  if (!botUserId) {
    return content.trim();
  }
  const mentionPrefix = new RegExp(`^<@!?${botUserId}>\\s*`);
  return content.replace(mentionPrefix, "").trim();
}

function createInteractionMessageAdapter(interaction) {
  let hasInitialReply = false;

  return {
    id: interaction.id,
    author: interaction.user,
    channel: interaction.channel,
    channelId: interaction.channelId,
    attachments: new Map(),
    reply: async (content) => {
      const payload = normalizeReplyPayload(content);
      if (!hasInitialReply && interaction.deferred) {
        hasInitialReply = true;
        return await interaction.editReply(payload);
      }
      if (!hasInitialReply && !interaction.replied) {
        hasInitialReply = true;
        return await interaction.reply({ ...payload, fetchReply: true });
      }
      return await interaction.followUp(payload);
    }
  };
}

function normalizeReplyPayload(content) {
  if (typeof content === "string") {
    return { content };
  }
  if (content && typeof content === "object") {
    return content;
  }
  return { content: String(content ?? "") };
}
