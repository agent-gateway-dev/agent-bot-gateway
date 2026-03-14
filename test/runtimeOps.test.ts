import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeOps } from "../src/app/runtimeOps.js";

const ORIGINAL_SELF_RESTART = process.env.DISCORD_SELF_RESTART_ON_REQUEST;
const tempDirs: string[] = [];

afterEach(async () => {
  if (ORIGINAL_SELF_RESTART === undefined) {
    delete process.env.DISCORD_SELF_RESTART_ON_REQUEST;
  } else {
    process.env.DISCORD_SELF_RESTART_ON_REQUEST = ORIGINAL_SELF_RESTART;
  }
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeRuntimeOps(overrides: { processStartedAt?: string; exitOnRestartAck?: boolean } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-runtimeops-"));
  tempDirs.push(base);
  const heartbeatPath = path.join(base, "bridge-heartbeat.json");
  const restartRequestPath = path.join(base, "restart-request.json");
  const restartAckPath = path.join(base, "restart-ack.json");
  const restartNoticePath = path.join(base, "restart-notice.json");
  const shutdownCalls: number[] = [];

  const runtimeOps = createRuntimeOps({
    fs,
    path,
    debugLog: () => {},
    activeTurns: new Map(),
    pendingApprovals: new Map(),
    heartbeatPath,
    restartRequestPath,
    restartAckPath,
    restartNoticePath,
    processStartedAt: overrides.processStartedAt ?? "2026-03-13T00:00:00.000Z",
    heartbeatIntervalMs: 30_000,
    exitOnRestartAck: overrides.exitOnRestartAck ?? false,
    safeReply: async () => null,
    safeSendToChannel: async () => null,
    fetchChannelByRouteId: async () => null,
    truncateStatusText: (value: string) => value,
    shutdown: async (exitCode: number) => {
      shutdownCalls.push(exitCode);
    }
  });

  return {
    runtimeOps,
    restartRequestPath,
    restartAckPath,
    shutdownCalls
  };
}

describe("runtime ops", () => {
  test("does not self-handle restart requests when host-managed ack mode is enabled by default", async () => {
    delete process.env.DISCORD_SELF_RESTART_ON_REQUEST;
    const { runtimeOps, restartRequestPath, restartAckPath, shutdownCalls } = await makeRuntimeOps({
      exitOnRestartAck: true
    });

    await fs.writeFile(
      restartRequestPath,
      JSON.stringify(
        {
          requestedAt: "2026-03-13T00:00:01.000Z",
          requestedBy: "cli",
          pid: 12345
        },
        null,
        2
      ),
      "utf8"
    );

    await runtimeOps.maybeHandleRestartRequestSignal();

    expect(shutdownCalls.length).toBe(0);
    await expect(fs.readFile(restartAckPath, "utf8")).rejects.toThrow();
    const pendingRaw = await fs.readFile(restartRequestPath, "utf8");
    expect(pendingRaw).toContain("requestedBy");
  });

  test("handles restart request in non-supervisor mode", async () => {
    process.env.DISCORD_SELF_RESTART_ON_REQUEST = "1";
    const { runtimeOps, restartRequestPath, restartAckPath, shutdownCalls } = await makeRuntimeOps();

    await fs.writeFile(
      restartRequestPath,
      JSON.stringify(
        {
          requestedAt: "2026-03-13T00:00:01.000Z",
          requestedBy: "cli",
          pid: 12345
        },
        null,
        2
      ),
      "utf8"
    );

    await runtimeOps.maybeHandleRestartRequestSignal();

    expect(shutdownCalls).toEqual([0]);
    const ackRaw = await fs.readFile(restartAckPath, "utf8");
    const ack = JSON.parse(ackRaw);
    expect(ack.handledBy).toBe("bridge-self");
    await expect(fs.readFile(restartRequestPath, "utf8")).rejects.toThrow();
  });

  test("ignores stale restart request from before process start", async () => {
    process.env.DISCORD_SELF_RESTART_ON_REQUEST = "1";
    const { runtimeOps, restartRequestPath, restartAckPath, shutdownCalls } = await makeRuntimeOps({
      processStartedAt: "2026-03-13T00:10:00.000Z"
    });

    await fs.writeFile(
      restartRequestPath,
      JSON.stringify(
        {
          requestedAt: "2026-03-13T00:00:01.000Z",
          requestedBy: "cli",
          pid: 12345
        },
        null,
        2
      ),
      "utf8"
    );

    await runtimeOps.maybeHandleRestartRequestSignal();

    expect(shutdownCalls.length).toBe(0);
    await expect(fs.readFile(restartAckPath, "utf8")).rejects.toThrow();
  });
});
