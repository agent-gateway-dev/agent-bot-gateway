import { getActiveAgentId, setupSupportsImageInput } from "../agents/setupResolution.js";
import { makeFeishuRouteId, parseFeishuRouteId } from "../feishu/ids.js";
import { makeScopedRouteId, parseScopedRouteId } from "../bots/scopedRoutes.js";

export function createCommandRouter(deps) {
  const {
    bot,
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
    getChannelSetups,
    setChannelSetups,
    bootstrapManagedRoutes,
    getPlatformRegistry,
    getOutputBufferSnapshot = () => []
  } = deps;

  async function handleCommand(message, content, context) {
    const [commandRaw, ...restParts] = content.split(/\s+/);
    const command = commandRaw.toLowerCase();
    const rest = restParts.join(" ").trim();

    if (command === "!help") {
      await safeReply(message, getHelpText({ platformId: inferPlatformId(message) }));
      return;
    }

    if (command === "!ask") {
      const imageAttachments = collectImageAttachments(message);
      if (!rest && imageAttachments.length === 0) {
        await safeReply(message, "Usage: `!ask <prompt>`");
        return;
      }
      if (imageAttachments.length > 0 && !setupSupportsImageInput(context.setup, config)) {
        const activeAgent = getActiveAgentId(context.setup, config);
        const agentLabel = activeAgent ? `\`${activeAgent}\`` : "current agent";
        await safeReply(
          message,
          `Image input is not supported for ${agentLabel}. Switch agent with \`!setagent <agent-id>\` or send text only.`
        );
        return;
      }
      const inputItems = await buildTurnInputFromMessage(message, rest, imageAttachments, context.setup);
      if (inputItems.length === 0) {
        await safeReply(message, "No usable text or image attachment found for `!ask`.");
        return;
      }
      enqueuePrompt(context.repoChannelId, {
        inputItems,
        message,
        bot: context.bot,
        setup: context.setup,
        repoChannelId: context.repoChannelId
      });
      return;
    }

    if (command === "!setpath") {
      await handleSetPathCommand(message, rest, context);
      return;
    }

    if (command === "!status") {
      const repoChannelId = resolveRepoChannelId(message, context);
      const queue = getQueue(repoChannelId);
      const binding = state.getBinding(repoChannelId);
      const sessionId = binding?.codexThreadId ?? null;
      const activeTurn = findActiveTurnByRepoChannel(repoChannelId);
      const sandboxMode = context.setup.sandboxMode ?? config.sandboxMode;
      const modeLabel = describeContextMode(context.setup);
      const fileWrites = context.setup.allowFileWrites === false ? "disabled" : "enabled";
      const runtime = resolveRuntime(context);
      await safeReply(
        message,
        [
          ...(context?.bot?.botId ? [`bot: \`${context.bot.botId}\``] : []),
          `runtime: \`${runtime}\``,
          `cwd: \`${context.setup.cwd}\``,
          `model: \`${context.setup.resolvedModel ?? context.setup.model ?? config.defaultModel}\`${context.setup.model ? " (channel override)" : " (default)"}`,
          `mode: ${modeLabel}`,
          `approval policy: \`${config.approvalPolicy}\``,
          `sandbox mode: \`${sandboxMode}\``,
          `file writes: ${fileWrites}`,
          `session: ${sessionId ? `\`${sessionId}\`` : "none"}`,
          `queue depth: ${queue.jobs.length}`,
          `active turn: ${activeTurn ? "yes" : "no"}`
        ].join("\n")
      );
      return;
    }

    if (command === "!screen") {
      const activeTurn = findActiveTurnByRepoChannel(context.repoChannelId);
      if (!activeTurn) {
        await safeReply(message, "No active turn in this channel.");
        return;
      }
      const lines = getOutputBufferSnapshot(activeTurn, 60);
      if (lines.length === 0) {
        await safeReply(message, "📺 Terminal output is empty.");
        return;
      }
      const display = lines.join("\n");
      const platformId = inferPlatformId(message);
      const maxLen = platformId === "feishu" ? 8000 : 1900;
      const truncated = truncateForDisplay(display, maxLen);
      await safeReply(message, `📺 Terminal output (${lines.length} lines):\n\`\`\`\n${truncated}\n\`\`\``);
      return;
    }

    if (command === "!log") {
      const activeTurn = findActiveTurnByRepoChannel(context.repoChannelId);
      if (!activeTurn) {
        await safeReply(message, "No active turn in this channel.");
        return;
      }
      const n = parseInt(rest, 10) || 20;
      const lineCount = Math.min(Math.max(1, n), 200);
      const lines = getOutputBufferSnapshot(activeTurn, lineCount);
      if (lines.length === 0) {
        await safeReply(message, "📜 No recent output.");
        return;
      }
      const display = lines.join("\n");
      const platformId = inferPlatformId(message);
      const maxLen = platformId === "feishu" ? 8000 : 1900;
      const truncated = truncateForDisplay(display, maxLen);
      await safeReply(message, `📜 Recent ${lines.length} lines:\n\`\`\`\n${truncated}\n\`\`\``);
      return;
    }

    if (command === "!new") {
      const repoChannelId = resolveRepoChannelId(message, context);
      state.clearBinding(repoChannelId);
      await state.save();
      await safeReply(message, "Cleared the current session binding for this chat. Next prompt starts a new session.");
      return;
    }

    if (command === "!restart") {
      await requestSelfRestartFromDiscord(message, rest || "manual restart requested from Discord command");
      return;
    }

    if (command === "!interrupt") {
      const repoChannelId = resolveRepoChannelId(message, context);
      const sessionId = state.getBinding(repoChannelId)?.codexThreadId;
      if (!sessionId) {
        await safeReply(message, "No runtime session is bound to this chat yet.");
        return;
      }
      try {
        await codex.request("turn/interrupt", { threadId: sessionId });
        await safeReply(message, "Interrupt requested.");
      } catch (error) {
        await safeReply(message, `Interrupt failed: ${error.message}`);
      }
      return;
    }

    if (command === "!where") {
      const repoChannelId = resolveRepoChannelId(message, context);
      const sessionId = state.getBinding(repoChannelId)?.codexThreadId;
      const sandboxMode = context.setup.sandboxMode ?? config.sandboxMode;
      const modeLabel = describeContextMode(context.setup);
      const fileWrites = context.setup.allowFileWrites === false ? "disabled" : "enabled";
      const runtime = resolveRuntime(context);
      const lines = [
        ...(context?.bot?.botId ? [`bot: \`${context.bot.botId}\``] : []),
        `runtime: \`${runtime}\``,
        `codex bin: \`${codexBin}\``,
        `CODEX_HOME: \`${codexHomeEnv ?? "(unset; codex default path)"}\``,
        `state file: \`${statePath}\``,
        `channel config: \`${configPath}\``,
        `channel mode: \`${modeLabel}\``,
        `channel cwd: \`${context.setup.cwd}\``,
        `channel model: \`${context.setup.resolvedModel ?? context.setup.model ?? config.defaultModel}\`${context.setup.model ? " (channel override)" : " (default)"}`,
        `repo channel: \`${repoChannelId}\``,
        `approval policy: \`${config.approvalPolicy}\``,
        `sandbox mode: \`${sandboxMode}\``,
        `file writes: \`${fileWrites}\``,
        `session: ${sessionId ? `\`${sessionId}\`` : "none"}`
      ];
      await safeReply(message, lines.join("\n"));
      return;
    }

    if (command === "!setmodel") {
      if (context.setup.mode === "general") {
        await safeReply(message, "`!setmodel` is only available in repo channels.");
        return;
      }
      const nextModel = String(rest ?? "").trim();
      if (!nextModel) {
        await safeReply(message, "Usage: `!setmodel <model>`");
        return;
      }

      const routeTarget = resolveRouteTarget(message, context);
      const existingSetup = getRouteSetup(getChannelSetups(), routeTarget);
      if (!existingSetup?.cwd) {
        await safeReply(message, "This channel is not bound to a repo path.");
        return;
      }

      const nextSetup = {
        ...existingSetup,
        model: nextModel
      };
      await persistChannelSetupToConfig(fs, path, configPath, routeTarget, nextSetup);

      const nextSetups = applyRouteSetupToSetups({ ...getChannelSetups() }, routeTarget, nextSetup);
      setChannelSetups(nextSetups);
      upsertRouteSetupInConfig(config, routeTarget, nextSetup);

      await safeReply(message, `Set this channel model override to \`${nextModel}\`.`);
      return;
    }

    if (command === "!clearmodel") {
      if (context.setup.mode === "general") {
        await safeReply(message, "`!clearmodel` is only available in repo channels.");
        return;
      }

      const routeTarget = resolveRouteTarget(message, context);
      const existingSetup = getRouteSetup(getChannelSetups(), routeTarget);
      if (!existingSetup?.cwd) {
        await safeReply(message, "This channel is not bound to a repo path.");
        return;
      }
      if (typeof existingSetup.model !== "string") {
        await safeReply(message, `This channel already uses the default model \`${config.defaultModel}\`.`);
        return;
      }

      const nextSetup = {
        ...existingSetup
      };
      delete nextSetup.model;
      await persistChannelSetupToConfig(fs, path, configPath, routeTarget, nextSetup);

      const nextSetups = applyRouteSetupToSetups({ ...getChannelSetups() }, routeTarget, nextSetup);
      setChannelSetups(nextSetups);
      upsertRouteSetupInConfig(config, routeTarget, nextSetup);

      await safeReply(message, `Cleared this channel model override. It will now use the default model \`${config.defaultModel}\`.`);
      return;
    }

    if (command === "!setagent") {
      if (context.setup.mode === "general") {
        await safeReply(message, "`!setagent` is only available in repo channels.");
        return;
      }
      const nextAgentId = String(rest ?? "").trim();
      if (!nextAgentId) {
        await safeReply(message, "Usage: `!setagent <agent-id>`");
        return;
      }

      const configuredAgentIds = Object.keys(config.agents ?? {});
      if (configuredAgentIds.length === 0) {
        await safeReply(
          message,
          "No agents configured in `channels.json` (`defaultAgent` / `agents`). Configure agents first, then use `!setagent`."
        );
        return;
      }
      if (!configuredAgentIds.includes(nextAgentId)) {
        await safeReply(
          message,
          `Unknown agent \`${nextAgentId}\`. Available: ${configuredAgentIds.map((agentId) => `\`${agentId}\``).join(", ")}`
        );
        return;
      }

      const routeTarget = resolveRouteTarget(message, context);
      const existingSetup = getRouteSetup(getChannelSetups(), routeTarget);
      if (!existingSetup?.cwd) {
        await safeReply(message, "This channel is not bound to a repo path.");
        return;
      }

      const nextSetup = {
        ...existingSetup,
        agentId: nextAgentId
      };
      await persistChannelSetupToConfig(fs, path, configPath, routeTarget, nextSetup);

      const nextSetups = applyRouteSetupToSetups({ ...getChannelSetups() }, routeTarget, nextSetup);
      setChannelSetups(nextSetups);
      upsertRouteSetupInConfig(config, routeTarget, nextSetup);

      await safeReply(message, `Set this channel agent override to \`${nextAgentId}\`.`);
      return;
    }

    if (command === "!clearagent") {
      if (context.setup.mode === "general") {
        await safeReply(message, "`!clearagent` is only available in repo channels.");
        return;
      }

      const routeTarget = resolveRouteTarget(message, context);
      const existingSetup = getRouteSetup(getChannelSetups(), routeTarget);
      if (!existingSetup?.cwd) {
        await safeReply(message, "This channel is not bound to a repo path.");
        return;
      }
      if (typeof existingSetup.agentId !== "string") {
        await safeReply(message, "This channel already uses the default agent.");
        return;
      }

      const nextSetup = {
        ...existingSetup
      };
      delete nextSetup.agentId;
      await persistChannelSetupToConfig(fs, path, configPath, routeTarget, nextSetup);

      const nextSetups = applyRouteSetupToSetups({ ...getChannelSetups() }, routeTarget, nextSetup);
      setChannelSetups(nextSetups);
      upsertRouteSetupInConfig(config, routeTarget, nextSetup);

      await safeReply(message, "Cleared this channel agent override. It will now use the default agent.");
      return;
    }

    if (command === "!agents") {
      const configuredAgents = config.agents && typeof config.agents === "object" ? config.agents : {};
      const agentIds = Object.keys(configuredAgents);
      const currentAgentId = getActiveAgentId(context.setup, config);
      if (agentIds.length === 0) {
        await safeReply(
          message,
          [
            "No agents configured in `channels.json` (`defaultAgent` / `agents`).",
            `Current model: \`${context.setup.resolvedModel ?? context.setup.model ?? config.defaultModel}\``,
            `Global runtime: \`${config.runtime || "codex"}\``
          ].join("\n")
        );
        return;
      }

      const lines = [
        `default agent: ${config.defaultAgent ? `\`${config.defaultAgent}\`` : "(none)"}`,
        `current agent: ${currentAgentId ? `\`${currentAgentId}\`` : "(none)"}`,
        `global runtime: \`${config.runtime || "codex"}\``,
        "available agents:"
      ];
      for (const agentId of agentIds) {
        const agent = configuredAgents[agentId] ?? {};
        const model = typeof agent.model === "string" && agent.model.trim().length > 0 ? agent.model.trim() : "(inherits defaultModel)";
        const enabled = agent.enabled === false ? "disabled" : "enabled";
        const runtime = agent.runtime === "claude" || agent.runtime === "codex" ? agent.runtime : "(inherits global)";
        const supportsImageInput = formatImageCapabilityLabel(agent);
        const marker = currentAgentId === agentId ? " <- current" : config.defaultAgent === agentId ? " <- default" : "";
        lines.push(`- \`${agentId}\` | ${enabled} | ${supportsImageInput} | model: \`${model}\` | runtime: \`${runtime}\`${marker}`);
      }
      await safeReply(message, lines.join("\n"));
      return;
    }

    if (command === "!approve" || command === "!decline" || command === "!cancel" || command === "!y" || command === "!n") {
      let token = rest;
      // !y and !n are aliases for approve/decline with latest token
      const isQuickApprove = command === "!y";
      const isQuickDecline = command === "!n";
      const effectiveCommand = isQuickApprove ? "!approve" : isQuickDecline ? "!decline" : command;

      if (!token) {
        token = findLatestPendingApprovalTokenForChannel(resolveRepoChannelId(message, context));
        if (!token) {
          const actionHint = isQuickApprove || isQuickDecline
            ? `No pending approvals. Use \`!approve <id>\` or \`!decline <id>\` when an approval is pending.`
            : `No pending approvals in this channel. Usage: \`${command} <id>\``;
          await safeReply(message, actionHint);
          return;
        }
      }
      const approval = pendingApprovals.get(token);
      if (!approval) {
        await safeReply(message, `No pending approval with id \`${token}\`.`);
        return;
      }
      if (approval.repoChannelId !== resolveRepoChannelId(message, context)) {
        await safeReply(message, "That approval belongs to a different channel.");
        return;
      }
      const decision = effectiveCommand === "!approve" ? "accept" : effectiveCommand === "!cancel" ? "cancel" : "decline";
      const result = await applyApprovalDecision(token, decision, `<@${message.author.id}>`);
      if (!result.ok) {
        await safeReply(message, `Failed to send approval response: ${result.error}`);
        return;
      }
      await safeReply(message, `${decision} sent for approval \`${token}\`.`);
      return;
    }

    await safeReply(message, "Unknown command. Use `!help`.");
  }

  function describeContextMode(setup) {
    const bindingKind = String(setup?.bindingKind ?? "").trim().toLowerCase();
    if (bindingKind === "unbound-open") {
      return "unbound-open";
    }
    return setup?.mode === "general" ? "general" : "repo channel";
  }

  async function runManagedRouteCommand(message, options = {}) {
    const { forceRebuild = false } = options;
    if (isDiscordBotFixedToNonCodexRuntime(bot)) {
      await safeReply(message, "Managed route sync is only available on Discord bots fixed to `codex`.");
      return;
    }

    const canBootstrapManagedRoutes =
      typeof bootstrapManagedRoutes === "function" ||
      resolvePlatformRegistry()?.anyPlatformSupports?.("supportsAutoDiscovery");
    if (!canBootstrapManagedRoutes) {
      await safeReply(message, "No configured platform currently supports managed route sync.");
      return;
    }

    try {
      const summaries = await runBootstrapManagedRoutes({ forceRebuild });
      const primary = summaries.find((summary) => summary?.platformId === "discord") ?? summaries[0] ?? summaries ?? null;
      if (!primary) {
        await safeReply(message, "No managed route changes were needed.");
        return;
      }
      await safeReply(message, formatManagedRouteSummary(primary, Object.keys(getChannelSetups()).length, forceRebuild));
    } catch (error) {
      await safeReply(message, `${forceRebuild ? "Rebuild" : "Resync"} failed: ${error.message}`);
    }
  }

  function getHelpText(options = {}) {
    const platformId = String(options.platformId ?? "discord").trim().toLowerCase() || "discord";
    const registry = resolvePlatformRegistry();
    const prefix = platformId === "feishu" ? "/" : "!";
    const capabilities = registry?.getCapabilities?.(platformId) ?? {};
    const supportsSlashCommands = capabilities.supportsSlashCommands === true;
    const supportsButtons = capabilities.supportsButtons === true;
    const supportsRepoBootstrap = resolveSupportsRepoBootstrap(platformId, capabilities);
    const supportsAutoDiscovery = resolveSupportsAutoDiscovery(platformId, registry);
    const isDiscordPlatform = platformId === "discord";

    const lines = [
      supportsSlashCommands ? "Commands (use `!command` or `/command`):" : `Commands (use \`${prefix}command\`):`
    ];

    if (supportsRepoBootstrap) {
      lines.push(`\`${prefix}initrepo [force]\` create/bind repo for this channel using channel name`);
    }
    if (isDiscordPlatform) {
      lines.push(`\`${prefix}mkchannel <name>\` create a new text channel`);
      lines.push(
        `\`${prefix}mkrepo <name>\` create a new text channel and bind a new project directory under WORKSPACE_ROOT`
      );
      lines.push(`\`${prefix}mkbind <name> <absolute-path>\` create a new text channel and bind it to a repo/path`);
      lines.push(`\`${prefix}bind <absolute-path>\` bind this channel to an existing repo/path`);
      lines.push(`\`${prefix}rebind <absolute-path>\` rebind this channel to a different existing repo/path`);
      lines.push(`\`${prefix}unbind\` remove repo binding from this channel`);
      lines.push(`\`${prefix}setmodel <model>\` set an explicit model override for this channel`);
      lines.push(`\`${prefix}clearmodel\` remove this channel's explicit model override and use the default model`);
      lines.push(`\`${prefix}setagent <agent-id>\` set an explicit agent override for this channel`);
      lines.push(`\`${prefix}clearagent\` remove this channel's explicit agent override and use the default agent`);
    }
    lines.push(`\`${prefix}setpath <abs-path>\` bind this chat to an existing repo path`);
    lines.push(`\`${prefix}agents\` show configured agents and current selection`);
    lines.push(`\`${prefix}ask <prompt>\` send prompt in this repo channel`);
    lines.push(`\`${prefix}status\` show queue/session status for this channel`);
    lines.push(`\`${prefix}screen\` show recent terminal output (last 60 lines)`);
    lines.push(`\`${prefix}log [n]\` show last n lines of output (default 20, max 200)`);
    lines.push(`\`${prefix}new\` reset the current session binding for this channel`);
    lines.push(`\`${prefix}restart [reason]\` request host-managed restart and confirm when back`);
    lines.push(`\`${prefix}interrupt\` interrupt current turn in this channel`);
    lines.push(`\`${prefix}where\` show bot runtime paths and binding details`);
    lines.push(`\`${prefix}approve [id]\` approve the latest (or specified) pending request`);
    lines.push(`\`${prefix}decline [id]\` decline the latest (or specified) pending request`);
    lines.push(`\`${prefix}cancel [id]\` cancel the latest (or specified) pending request`);
    lines.push(`\`${prefix}y\` approve the latest pending request (quick alias)`);
    lines.push(`\`${prefix}n\` decline the latest pending request (quick alias)`);
    if (supportsAutoDiscovery) {
      lines.push(`\`${prefix}resync\` non-destructive sync with managed project routes`);
      lines.push(`\`${prefix}rebuild\` destructive rebuild of managed project routes`);
    }
    if (supportsButtons) {
      lines.push("Tip: use the Approve/Decline/Cancel buttons on approval messages");
    }
    lines.push("Model: one chat route = one persistent runtime session");
    lines.push("Also supported in #general-style chats: plain chat and commands (read-only, no file writes)");

    if (!supportsRepoBootstrap && platformId === "feishu") {
      lines.push("Feishu repo chat bindings are config-driven via `config/channels.json` keys like `feishu:oc_xxx`.");
    }
    if (platformId === "feishu") {
      lines.push("Group chats default to command messages or messages that @mention the bot.");
    }

    return lines.join("\n");
  }

  function isCommandSupportedForPlatform(commandName, platformId) {
    const normalizedCommandName = String(commandName ?? "").trim().toLowerCase();
    const normalizedPlatformId = String(platformId ?? "").trim().toLowerCase();
    const registry = resolvePlatformRegistry();
    if (!registry) {
      return normalizedPlatformId !== "feishu" || !DISCORD_ONLY_COMMANDS.has(normalizedCommandName);
    }

    if (normalizedCommandName === "initrepo") {
      return registry.platformSupports?.(normalizedPlatformId, "supportsRepoBootstrap") ?? false;
    }
    if (normalizedCommandName === "resync" || normalizedCommandName === "rebuild") {
      return registry.anyPlatformSupports?.("supportsAutoDiscovery") ?? false;
    }
    if (DISCORD_ONLY_COMMANDS.has(normalizedCommandName)) {
      return normalizedPlatformId === "discord";
    }
    return true;
  }

  function resolvePlatformRegistry() {
    return typeof getPlatformRegistry === "function" ? getPlatformRegistry() : null;
  }

  async function runBootstrapManagedRoutes(options) {
    if (typeof bootstrapManagedRoutes === "function") {
      const summary = await bootstrapManagedRoutes(options);
      return Array.isArray(summary) ? summary : summary ? [summary] : [];
    }
    const registry = resolvePlatformRegistry();
    return await registry.bootstrapRoutes(options);
  }

  function resolveSupportsRepoBootstrap(platformId, capabilities) {
    const platformSupportsRepoBootstrap = capabilities.supportsRepoBootstrap === true;
    if (platformId !== "discord") {
      return platformSupportsRepoBootstrap;
    }
    if (!bot) {
      return platformSupportsRepoBootstrap;
    }
    return platformSupportsRepoBootstrap && !isDiscordBotFixedToNonCodexRuntime(bot);
  }

  function resolveSupportsAutoDiscovery(platformId, registry) {
    if (platformId !== "discord") {
      return registry?.anyPlatformSupports?.("supportsAutoDiscovery") ?? false;
    }
    if (isDiscordBotFixedToNonCodexRuntime(bot)) {
      return false;
    }
    if (typeof bootstrapManagedRoutes === "function") {
      return true;
    }
    return registry?.anyPlatformSupports?.("supportsAutoDiscovery") ?? true;
  }

  function inferPlatformId(message) {
    return String(message?.platform ?? "discord").trim().toLowerCase() || "discord";
  }

  function resolveRouteTarget(message, context = null) {
    const platformId = String(context?.bot?.platform ?? bot?.platform ?? inferPlatformId(message)).trim().toLowerCase() || "discord";
    const contextRouteId = String(context?.repoChannelId ?? "").trim();
    const scopedRoute = parseScopedRouteId(contextRouteId);
    const botId = String(context?.bot?.botId ?? bot?.botId ?? scopedRoute?.botId ?? "").trim();
    const rawChannelId = String(message?.channelId ?? message?.channel?.id ?? "").trim();
    const rawFeishuRouteId = rawChannelId || String(message?.channel?.chatId ?? "").trim();
    const feishuExternalRouteId =
      parseFeishuRouteId(rawFeishuRouteId) ?? String(message?.channel?.chatId ?? "").trim() ?? rawFeishuRouteId;
    const externalRouteId =
      scopedRoute?.externalRouteId ??
      (platformId === "feishu" ? feishuExternalRouteId || rawFeishuRouteId : rawChannelId);
    const legacyRouteId = platformId === "feishu" ? makeFeishuRouteId(externalRouteId) || rawFeishuRouteId : externalRouteId;
    const repoChannelId = contextRouteId || makeScopedRouteId(botId, externalRouteId) || legacyRouteId;

    return {
      platformId,
      botId: botId || null,
      externalRouteId: externalRouteId || null,
      legacyRouteId: legacyRouteId || null,
      repoChannelId
    };
  }

  function resolveRepoChannelId(message, context = null) {
    return resolveRouteTarget(message, context).repoChannelId;
  }

  function resolveRuntime(context = null) {
    const contextRuntime = String(context?.setup?.runtime ?? context?.bot?.runtime ?? bot?.runtime ?? "").trim().toLowerCase();
    if (contextRuntime === "claude" || contextRuntime === "codex") {
      return contextRuntime;
    }
    return config.runtime || "codex";
  }

  function truncateForDisplay(text, maxLen) {
    if (text.length <= maxLen) {
      return text;
    }
    const suffix = "\n...[truncated]";
    return text.slice(0, maxLen - suffix.length) + suffix;
  }

  async function handleInitRepoCommand(message, rest) {
    if (message.channel.type !== ChannelType.GuildText) {
      await safeReply(message, "`!initrepo` is only available in server text channels.");
      return;
    }
    if (isGeneralChannel(message.channel)) {
      await safeReply(message, "`!initrepo` is disabled in #general (read-only channel).");
      return;
    }
    if (!repoRootPath) {
      await safeReply(message, "Set `WORKSPACE_ROOT` in `.env` before using `!initrepo`.");
      return;
    }

    const force = rest.toLowerCase() === "force";
    const repoName = makeChannelName(message.channel.name);
    const repoPath = path.join(repoRootPath, repoName);
    const channelSetups = getChannelSetups();
    const existingSetup = channelSetups[message.channelId];

    if (existingSetup && existingSetup.cwd !== repoPath && !force) {
      await safeReply(
        message,
        `This channel is already bound to \`${existingSetup.cwd}\`. Use \`!initrepo force\` to rebind.`
      );
      return;
    }

    await fs.mkdir(repoRootPath, { recursive: true });
    const repoExists = await pathExists(fs, repoPath);
    if (repoExists && !force && (!existingSetup || existingSetup.cwd !== repoPath)) {
      await safeReply(
        message,
        `Repo path already exists: \`${repoPath}\`. Rename channel or run \`!initrepo force\`.`
      );
      return;
    }

    await fs.mkdir(repoPath, { recursive: true });
    await initializeRepoPath(repoPath);

    await bindChannelToPath(message.channel, message.channelId, repoPath);

    await safeReply(
      message,
      `Initialized repo \`${repoName}\` at \`${repoPath}\` and bound this channel.`
    );
  }

  async function handleSetPathCommand(message, rest, context = null) {
    const routeTarget = resolveRouteTarget(message, context);
    if (!routeTarget.repoChannelId) {
      await safeReply(message, "Unable to determine the current chat route.");
      return;
    }

    const rawPath = String(rest ?? "").trim();
    if (!rawPath) {
      await safeReply(message, "Usage: `!setpath /absolute/path/to/repo`");
      return;
    }

    const targetPath = path.resolve(rawPath);
    let stats = null;
    try {
      stats = await fs.stat(targetPath);
    } catch {
      await safeReply(message, `Path does not exist: \`${targetPath}\``);
      return;
    }
    if (typeof stats?.isDirectory === "function" && !stats.isDirectory()) {
      await safeReply(message, `Path is not a directory: \`${targetPath}\``);
      return;
    }

    const channelSetups = getChannelSetups();
    const existingSetup = getRouteSetup(channelSetups, routeTarget);
    if (existingSetup?.cwd === targetPath) {
      await safeReply(message, `This chat is already bound to \`${targetPath}\`.`);
      return;
    }

    const explicitModel = pickExplicitModelOverride(existingSetup, getConfiguredRouteSetup(config, routeTarget));

    const nextSetup = {
      cwd: targetPath,
      ...(typeof existingSetup?.agentId === "string" ? { agentId: existingSetup.agentId } : {}),
      ...(typeof explicitModel === "string" ? { model: explicitModel } : {})
    };

    await persistChannelSetupToConfig(fs, path, configPath, routeTarget, nextSetup);

    const nextSetups = applyRouteSetupToSetups({ ...channelSetups }, routeTarget, nextSetup);
    setChannelSetups(nextSetups);
    upsertRouteSetupInConfig(config, routeTarget, nextSetup);

    state.clearBinding(routeTarget.repoChannelId);
    await state.save();

    if (
      message?.channel?.type === ChannelType.GuildText &&
      typeof message?.channel?.setTopic === "function" &&
      managedChannelTopicPrefix
    ) {
      const nextTopic = upsertTopicTag(message.channel.topic, managedChannelTopicPrefix, targetPath);
      if (nextTopic !== message.channel.topic) {
        await message.channel.setTopic(nextTopic).catch((error) => {
          console.warn(`failed setting channel topic for ${routeTarget.repoChannelId}: ${error.message}`);
        });
      }
    }

    await safeReply(
      message,
      [
        `Bound this chat to \`${targetPath}\`.`,
        "Cleared the existing Codex thread binding.",
        "Next prompt will start a new Codex thread in the new working path."
      ].join("\n")
    );
  }

  async function handleBindCommand(message, rest, options = {}) {
    if (message.channel.type !== ChannelType.GuildText) {
      await safeReply(message, `\`${options.rebind ? "!rebind" : "!bind"}\` is only available in server text channels.`);
      return;
    }
    if (isGeneralChannel(message.channel)) {
      await safeReply(message, `\`${options.rebind ? "!rebind" : "!bind"}\` is disabled in #general (read-only channel).`);
      return;
    }

    const targetPath = String(rest ?? "").trim();
    if (!targetPath) {
      await safeReply(message, `Usage: \`${options.rebind ? "!rebind" : "!bind"} <absolute-path>\``);
      return;
    }
    if (!path.isAbsolute(targetPath)) {
      await safeReply(message, "Provide an absolute path, for example `/Users/jonashan/openclaw-web`.");
      return;
    }

    const repoPath = path.resolve(targetPath);
    const stats = await fs.stat(repoPath).catch(() => null);
    if (!stats?.isDirectory()) {
      await safeReply(message, `Path does not exist or is not a directory: \`${repoPath}\``);
      return;
    }

    const channelSetups = getChannelSetups();
    const existingSetup = channelSetups[message.channelId];
    if (existingSetup?.cwd === repoPath) {
      await safeReply(message, `This channel is already bound to \`${repoPath}\`.`);
      return;
    }
    if (existingSetup && !options.rebind) {
      await safeReply(
        message,
        `This channel is already bound to \`${existingSetup.cwd}\`. Use \`!rebind ${repoPath}\` to switch.`
      );
      return;
    }

    await bindChannelToPath(message.channel, message.channelId, repoPath, {
      ...(typeof existingSetup?.agentId === "string" ? { agentId: existingSetup.agentId } : {}),
      ...(typeof existingSetup?.model === "string" ? { model: existingSetup.model } : {})
    });

    await safeReply(
      message,
      `${options.rebind ? "Rebound" : "Bound"} this channel to \`${repoPath}\`. Next prompt starts a fresh Codex thread.`
    );
  }

  async function handleMakeChannelCommand(message, rest, options = {}) {
    if (message.channel.type !== ChannelType.GuildText) {
      await safeReply(
        message,
        `\`${options.bindPath ? "!mkbind" : options.initRepo ? "!mkrepo" : "!mkchannel"}\` is only available in server text channels.`
      );
      return;
    }

    const parsed = parseMakeChannelArgs(rest, path, {
      requirePath: Boolean(options.bindPath),
      initRepo: Boolean(options.initRepo)
    });
    if (!parsed.ok) {
      await safeReply(message, parsed.error);
      return;
    }

    const guild = message.guild;
    if (!guild) {
      await safeReply(message, "This command only works inside a Discord server.");
      return;
    }

    await guild.channels.fetch().catch(() => null);
    const baseName = makeChannelName(parsed.channelName);
    const channelName = uniqueGuildTextChannelName(guild, baseName, ChannelType.GuildText);
    const parent = message.channel.parentId ?? undefined;
    const repoPath = options.initRepo && repoRootPath ? path.join(repoRootPath, channelName) : null;

    if (options.bindPath) {
      const stats = await fs.stat(parsed.bindPath).catch(() => null);
      if (!stats?.isDirectory()) {
        await safeReply(message, `Path does not exist or is not a directory: \`${parsed.bindPath}\``);
        return;
      }
    }

    if (options.initRepo) {
      if (!repoRootPath) {
        await safeReply(message, "Set `WORKSPACE_ROOT` in `.env` before using `!mkrepo`.");
        return;
      }
      await fs.mkdir(repoRootPath, { recursive: true });
      if (await pathExists(fs, repoPath)) {
        await safeReply(
          message,
          `Repo path already exists: \`${repoPath}\`. Choose a different channel name or use \`!mkchannel\` + \`!bind\`.`
        );
        return;
      }
    }

    let createdChannel;
    try {
      createdChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        ...(parent ? { parent } : {})
      });
    } catch (error) {
      await safeReply(message, `Failed to create channel: ${error.message}`);
      return;
    }

    if (options.initRepo) {
      try {
        await fs.mkdir(repoPath, { recursive: true });
        await bindChannelToPath(createdChannel, createdChannel.id, repoPath);
        await safeReply(
          message,
          `Created channel <#${createdChannel.id}> and bound it to new project path \`${repoPath}\`.`
        );
      } catch (error) {
        await safeReply(
          message,
          `Created channel <#${createdChannel.id}>, but project path setup failed: ${error.message}`
        );
      }
      return;
    }

    if (!options.bindPath) {
      await safeReply(message, `Created channel <#${createdChannel.id}>.`);
      return;
    }

    try {
      await bindChannelToPath(createdChannel, createdChannel.id, parsed.bindPath);
      await safeReply(message, `Created channel <#${createdChannel.id}> and bound it to \`${parsed.bindPath}\`.`);
    } catch (error) {
      await safeReply(
        message,
        `Created channel <#${createdChannel.id}>, but binding failed: ${error.message}`
      );
    }
  }

  async function handleUnbindCommand(message) {
    if (message.channel.type !== ChannelType.GuildText) {
      await safeReply(message, "`!unbind` is only available in server text channels.");
      return;
    }
    if (isGeneralChannel(message.channel)) {
      await safeReply(message, "`!unbind` is disabled in #general (read-only channel).");
      return;
    }

    const routeTarget = resolveRouteTarget(message);
    const channelSetups = getChannelSetups();
    const existingSetup = getRouteSetup(channelSetups, routeTarget);
    if (!existingSetup) {
      await safeReply(message, "This channel is not bound to a repo path.");
      return;
    }

    const nextSetups = removeRouteSetupFromSetups({ ...channelSetups }, routeTarget);
    await removeChannelSetupFromConfig(fs, path, configPath, routeTarget);
    setChannelSetups(nextSetups);
    removeRouteSetupFromConfigObject(config, routeTarget);
    state.clearBinding(routeTarget.repoChannelId);
    await state.save();

    const nextTopic = removeTopicTag(message.channel.topic, managedChannelTopicPrefix);
    if (nextTopic !== message.channel.topic) {
      await message.channel.setTopic(nextTopic).catch((error) => {
        console.warn(`failed clearing channel topic for ${routeTarget.repoChannelId}: ${error.message}`);
      });
    }

    await safeReply(
      message,
      `Unbound this channel from \`${existingSetup.cwd}\`. Plain messages will stop routing here until you bind it again.`
    );
  }

  async function bindChannelToPath(channel, channelId, repoPath, options = {}) {
    const routeTarget = resolveRouteTarget({
      channelId,
      channel,
      platform: String(bot?.platform ?? "discord").trim().toLowerCase() || "discord"
    });
    const nextSetup = {
      cwd: repoPath,
      ...(typeof options.agentId === "string" ? { agentId: options.agentId } : {}),
      ...(typeof options.model === "string" ? { model: options.model } : {})
    };

    await persistChannelSetupToConfig(fs, path, configPath, routeTarget, nextSetup);

    const nextSetups = applyRouteSetupToSetups({ ...getChannelSetups() }, routeTarget, nextSetup);
    setChannelSetups(nextSetups);
    upsertRouteSetupInConfig(config, routeTarget, nextSetup);
    state.clearBinding(routeTarget.repoChannelId);
    await state.save();

    const nextTopic = upsertTopicTag(channel.topic, managedChannelTopicPrefix, repoPath);
    if (nextTopic !== channel.topic && typeof channel.setTopic === "function") {
      await channel.setTopic(nextTopic).catch((error) => {
        console.warn(`failed setting channel topic for ${routeTarget.repoChannelId}: ${error.message}`);
      });
    }
  }

  async function initializeRepoPath(repoPath) {
    await execFileAsync("git", ["-C", repoPath, "init"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    });
  }

  return {
    getHelpText,
    isCommandSupportedForPlatform,
    runManagedRouteCommand,
    handleCommand,
    handleInitRepoCommand,
    handleSetPathCommand,
    handleMakeChannelCommand,
    handleBindCommand,
    handleUnbindCommand
  };
}

function formatManagedRouteSummary(summary, mappedCount, forceRebuild) {
  if (forceRebuild) {
    return `Rebuilt channels. nuked_channels=${summary.deletedChannels}, nuked_categories=${summary.deletedCategories}, cleared_bindings=${summary.clearedBindings}, discovered=${summary.discoveredCwds}, created=${summary.createdChannels}, moved=${summary.movedChannels}, pruned=${summary.prunedBindings}, mapped=${mappedCount}`;
  }
  return `Resynced channels. discovered=${summary.discoveredCwds}, created=${summary.createdChannels}, moved=${summary.movedChannels}, pruned=${summary.prunedBindings}, mapped=${mappedCount}`;
}

const DISCORD_ONLY_COMMANDS = new Set([
  "mkchannel",
  "mkrepo",
  "mkbind",
  "bind",
  "rebind",
  "unbind",
  "setmodel",
  "clearmodel",
  "setagent",
  "clearagent"
]);

function isDiscordBotFixedToNonCodexRuntime(bot) {
  const platform = String(bot?.platform ?? "discord").trim().toLowerCase();
  const runtime = String(bot?.runtime ?? "").trim().toLowerCase();
  return platform === "discord" && runtime.length > 0 && runtime !== "codex";
}

function upsertTopicTag(topic, prefix, value) {
  const safeValue = String(value ?? "").trim();
  if (!safeValue) {
    return typeof topic === "string" ? topic : "";
  }
  const lines = typeof topic === "string" && topic.trim() ? topic.split(/\n+/).map((line) => line.trim()) : [];
  const kept = lines.filter((line) => !line.startsWith(prefix));
  kept.push(`${prefix}${safeValue}`);
  return kept.join("\n").trim();
}

function removeTopicTag(topic, prefix) {
  const lines = typeof topic === "string" && topic.trim() ? topic.split(/\n+/).map((line) => line.trim()) : [];
  return lines.filter((line) => !line.startsWith(prefix)).join("\n").trim();
}

function formatImageCapabilityLabel(agent) {
  const capabilities = agent?.capabilities;
  const hasDeclaredCapability =
    capabilities &&
    typeof capabilities === "object" &&
    Object.prototype.hasOwnProperty.call(capabilities, "supportsImageInput");
  if (!hasDeclaredCapability) {
    return "image✅(default)";
  }
  return capabilities.supportsImageInput === true ? "image✅" : "image❌";
}

function pickExplicitModelOverride(...candidates) {
  for (const candidate of candidates) {
    const model = typeof candidate?.model === "string" ? candidate.model.trim() : "";
    if (model.length > 0) {
      return model;
    }
  }
  return null;
}

function parseMakeChannelArgs(rest, pathModule, options = {}) {
  const requirePath = options.requirePath === true;
  const initRepo = options.initRepo === true;
  const text = String(rest ?? "").trim();
  if (!text) {
    return {
      ok: false,
      error: requirePath
        ? "Usage: `!mkbind <channel-name> <absolute-path>`"
        : initRepo
          ? "Usage: `!mkrepo <channel-name>`"
        : "Usage: `!mkchannel <channel-name>`"
    };
  }

  if (!requirePath) {
    return { ok: true, channelName: text };
  }

  const parts = text.split(/\s+/);
  let pathStart = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (pathModule.isAbsolute(parts[index])) {
      pathStart = index;
      break;
    }
  }
  if (pathStart <= 0) {
    return {
      ok: false,
      error: "Usage: `!mkbind <channel-name> <absolute-path>`"
    };
  }

  const channelName = parts.slice(0, pathStart).join(" ").trim();
  const bindPath = pathModule.resolve(parts.slice(pathStart).join(" ").trim());
  if (!channelName) {
    return {
      ok: false,
      error: "Usage: `!mkbind <channel-name> <absolute-path>`"
    };
  }

  return {
    ok: true,
    channelName,
    bindPath
  };
}

function uniqueGuildTextChannelName(guild, baseName, textChannelType) {
  let candidate = baseName;
  let index = 2;
  const lowerExisting = new Set(
    [...guild.channels.cache.values()]
      .filter((channel) => channel.type === textChannelType)
      .map((channel) => channel.name.toLowerCase())
  );

  while (lowerExisting.has(candidate.toLowerCase())) {
    const suffix = `-${index}`;
    candidate = `${baseName.slice(0, Math.max(1, 100 - suffix.length))}${suffix}`;
    index += 1;
  }

  return candidate;
}

async function pathExists(fsModule, targetPath) {
  try {
    await fsModule.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function getRouteSetup(channelSetups, routeTarget) {
  if (!routeTarget?.repoChannelId) {
    return null;
  }
  return (
    channelSetups?.[routeTarget.repoChannelId] ??
    channelSetups?.[routeTarget.legacyRouteId] ??
    channelSetups?.[routeTarget.externalRouteId] ??
    null
  );
}

function applyRouteSetupToSetups(channelSetups, routeTarget, setup) {
  const nextSetups = { ...(channelSetups ?? {}) };
  for (const candidateKey of [routeTarget?.legacyRouteId, routeTarget?.externalRouteId]) {
    if (candidateKey && candidateKey !== routeTarget?.repoChannelId) {
      delete nextSetups[candidateKey];
    }
  }
  if (routeTarget?.repoChannelId) {
    nextSetups[routeTarget.repoChannelId] = setup;
  }
  return nextSetups;
}

function removeRouteSetupFromSetups(channelSetups, routeTarget) {
  const nextSetups = { ...(channelSetups ?? {}) };
  for (const candidateKey of [routeTarget?.repoChannelId, routeTarget?.legacyRouteId, routeTarget?.externalRouteId]) {
    if (candidateKey) {
      delete nextSetups[candidateKey];
    }
  }
  return nextSetups;
}

function getConfiguredRouteSetup(config, routeTarget) {
  if (routeTarget?.botId && config?.bots?.[routeTarget.botId]?.routes?.[routeTarget.externalRouteId]) {
    return config.bots[routeTarget.botId].routes[routeTarget.externalRouteId];
  }
  return config?.channels?.[routeTarget?.legacyRouteId] ?? config?.channels?.[routeTarget?.repoChannelId] ?? null;
}

function upsertRouteSetupInConfig(config, routeTarget, setup) {
  if (!config || typeof config !== "object") {
    return;
  }
  if (routeTarget?.botId) {
    if (!config.bots || typeof config.bots !== "object") {
      config.bots = {};
    }
    const botConfig = config.bots[routeTarget.botId] ?? {};
    const routes =
      botConfig.routes && typeof botConfig.routes === "object" && !Array.isArray(botConfig.routes)
        ? { ...botConfig.routes }
        : {};
    routes[routeTarget.externalRouteId] = buildPersistedSetup(setup);
    config.bots[routeTarget.botId] = {
      ...botConfig,
      routes
    };
    return;
  }

  if (!config.channels || typeof config.channels !== "object") {
    config.channels = {};
  }
  config.channels[routeTarget.legacyRouteId] = buildPersistedSetup(setup);
}

function removeRouteSetupFromConfigObject(config, routeTarget) {
  if (!config || typeof config !== "object") {
    return;
  }
  if (routeTarget?.botId) {
    const routes = config?.bots?.[routeTarget.botId]?.routes;
    if (routes && typeof routes === "object") {
      delete routes[routeTarget.externalRouteId];
    }
    return;
  }

  if (config.channels && typeof config.channels === "object") {
    delete config.channels[routeTarget.legacyRouteId];
    if (routeTarget.repoChannelId && routeTarget.repoChannelId !== routeTarget.legacyRouteId) {
      delete config.channels[routeTarget.repoChannelId];
    }
  }
}

async function persistChannelSetupToConfig(fsModule, pathModule, targetConfigPath, routeTarget, setup) {
  const document = await readConfigDocument(fsModule, targetConfigPath);
  if (routeTarget?.botId) {
    const bots =
      document && typeof document.bots === "object" && document.bots !== null && !Array.isArray(document.bots)
        ? { ...document.bots }
        : {};
    const botDocument = bots[routeTarget.botId] && typeof bots[routeTarget.botId] === "object" ? { ...bots[routeTarget.botId] } : {};
    const routes =
      botDocument.routes && typeof botDocument.routes === "object" && botDocument.routes !== null && !Array.isArray(botDocument.routes)
        ? { ...botDocument.routes }
        : {};
    routes[routeTarget.externalRouteId] = buildPersistedSetup(setup);
    botDocument.routes = routes;
    bots[routeTarget.botId] = botDocument;
    document.bots = bots;
  } else {
    const channels =
      document && typeof document.channels === "object" && document.channels !== null && !Array.isArray(document.channels)
        ? { ...document.channels }
        : {};
    channels[routeTarget.legacyRouteId] = buildPersistedSetup(setup);
    document.channels = channels;
  }
  await writeConfigDocument(fsModule, pathModule, targetConfigPath, document);
}

async function removeChannelSetupFromConfig(fsModule, pathModule, targetConfigPath, routeTarget) {
  const document = await readConfigDocument(fsModule, targetConfigPath);
  if (routeTarget?.botId) {
    const bots =
      document && typeof document.bots === "object" && document.bots !== null && !Array.isArray(document.bots)
        ? { ...document.bots }
        : {};
    const botDocument = bots[routeTarget.botId] && typeof bots[routeTarget.botId] === "object" ? { ...bots[routeTarget.botId] } : {};
    const routes =
      botDocument.routes && typeof botDocument.routes === "object" && botDocument.routes !== null && !Array.isArray(botDocument.routes)
        ? { ...botDocument.routes }
        : {};
    delete routes[routeTarget.externalRouteId];
    botDocument.routes = routes;
    bots[routeTarget.botId] = botDocument;
    document.bots = bots;
  } else {
    const channels =
      document && typeof document.channels === "object" && document.channels !== null && !Array.isArray(document.channels)
        ? { ...document.channels }
        : {};
    delete channels[routeTarget.legacyRouteId];
    if (routeTarget?.repoChannelId && routeTarget.repoChannelId !== routeTarget.legacyRouteId) {
      delete channels[routeTarget.repoChannelId];
    }
    document.channels = channels;
  }
  await writeConfigDocument(fsModule, pathModule, targetConfigPath, document);
}

function buildPersistedSetup(setup) {
  return {
    cwd: setup.cwd,
    ...(typeof setup.agentId === "string" ? { agentId: setup.agentId } : {}),
    ...(typeof setup.model === "string" ? { model: setup.model } : {})
  };
}

async function readConfigDocument(fsModule, targetConfigPath) {
  try {
    const raw = await fsModule.readFile(targetConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Channel config is not valid JSON: ${targetConfigPath}`);
    }
    throw error;
  }
}

async function writeConfigDocument(fsModule, pathModule, targetConfigPath, document) {
  await fsModule.mkdir(pathModule.dirname(targetConfigPath), { recursive: true });
  await fsModule.writeFile(targetConfigPath, JSON.stringify(document, null, 2), "utf8");
}
