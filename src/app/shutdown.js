import process from "node:process";

export function createShutdownHandler({ codex, discord, stopHeartbeatLoop }) {
  let shuttingDown = false;
  return async function shutdown(exitCode) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    stopHeartbeatLoop?.();
    try {
      await codex.stop();
    } catch {}
    discord.destroy();
    process.exit(exitCode);
  };
}
