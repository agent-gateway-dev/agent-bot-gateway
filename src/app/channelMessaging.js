export function createChannelMessaging(deps) {
  const { discord } = deps;

  async function safeReply(message, content) {
    try {
      return await message.reply(content);
    } catch (error) {
      if (!isChannelUnavailableError(error)) {
        throw error;
      }
      const channel = await discord.channels.fetch(message.channelId).catch(() => null);
      if (channel && channel.isTextBased()) {
        try {
          return await channel.send(content);
        } catch (sendError) {
          if (!isChannelUnavailableError(sendError)) {
            throw sendError;
          }
        }
      }
      console.warn(`reply dropped in unavailable channel ${message.channelId}`);
      return null;
    }
  }

  async function safeSendToChannel(channel, text) {
    if (!channel || !channel.isTextBased()) {
      return null;
    }
    try {
      return await channel.send(text);
    } catch (error) {
      if (!isChannelUnavailableError(error)) {
        throw error;
      }
      return null;
    }
  }

  async function safeSendToChannelPayload(channel, payload) {
    if (!channel || !channel.isTextBased()) {
      return null;
    }
    try {
      return await channel.send(payload);
    } catch (error) {
      if (!isChannelUnavailableError(error)) {
        throw error;
      }
      return null;
    }
  }

  return {
    safeReply,
    safeSendToChannel,
    safeSendToChannelPayload
  };
}

export function isChannelUnavailableError(error) {
  const code = String(error?.code ?? "");
  const apiCode = Number(error?.rawError?.code ?? 0);
  const message = String(error?.message ?? "").toLowerCase();
  return (
    code === "ChannelNotCached" ||
    code === "10003" ||
    apiCode === 10003 ||
    message.includes("channel not cached") ||
    message.includes("unknown channel")
  );
}
