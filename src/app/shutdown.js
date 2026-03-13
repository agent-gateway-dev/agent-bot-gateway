import process from "node:process";

export function createShutdownHandler({ codex, discord, stopHeartbeatLoop, stopBackendRuntime, stopPlatformRuntimes }) {
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
    await stopBackendRuntime?.();
    await stopPlatformRuntimes?.();
    discord.destroy();
    process.exit(exitCode);
  };
}
