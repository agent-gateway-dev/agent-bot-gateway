import { ChannelType } from "discord.js";

export function isGeneralChannel(channel, generalChannel) {
  if (channel?.type !== ChannelType.GuildText) {
    return false;
  }
  const generalChannelId = String(generalChannel?.id ?? "").trim();
  if (generalChannelId) {
    return channel.id === generalChannelId;
  }
  const configuredName = String(generalChannel?.name ?? "general")
    .trim()
    .toLowerCase();
  return channel.name.toLowerCase() === configuredName;
}

export function resolveRepoContext(message, options) {
  const { channelSetups, config, generalChannel } = options;
  if (message.channel.type !== ChannelType.GuildText) {
    return null;
  }

  const setup = channelSetups[message.channelId];
  if (!setup) {
    if (!isGeneralChannel(message.channel, generalChannel)) {
      return null;
    }
    return {
      repoChannelId: message.channelId,
      setup: {
        cwd: generalChannel.cwd,
        model: config.defaultModel,
        mode: "general",
        sandboxMode: "read-only",
        allowFileWrites: false
      }
    };
  }

  return {
    repoChannelId: message.channelId,
    setup: {
      ...setup,
      mode: "repo",
      sandboxMode: config.sandboxMode,
      allowFileWrites: true
    }
  };
}
