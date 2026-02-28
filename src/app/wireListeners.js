export function wireBridgeListeners({
  codex,
  discord,
  handleNotification,
  handleServerRequest,
  handleMessage,
  handleInteraction
}) {
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
}
