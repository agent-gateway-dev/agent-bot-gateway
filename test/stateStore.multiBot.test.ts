import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { StateStore } from "../src/stateStore.js";

const tempPaths = new Set<string>();

afterEach(() => {
  for (const filePath of tempPaths) {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
  tempPaths.clear();
});

function createStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-bridge-state-store-"));
  const filePath = path.join(dir, "state.json");
  tempPaths.add(filePath);
  return filePath;
}

function writeState(filePath: string, payload: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

describe("StateStore multi-bot", () => {
  test("stores bindings by scoped route id", async () => {
    const statePath = createStatePath();
    const store = new StateStore(statePath, {
      bots: {
        "discord-main": {
          platform: "discord"
        }
      }
    });

    await store.load();
    store.setBinding("bot:discord-main:route:123", {
      botId: "discord-main",
      platform: "discord",
      externalRouteId: "123",
      codexThreadId: "thread-1"
    });
    await store.save();

    expect(store.getBinding("bot:discord-main:route:123")).toEqual(
      expect.objectContaining({
        botId: "discord-main",
        platform: "discord",
        externalRouteId: "123",
        repoChannelId: "bot:discord-main:route:123",
        codexThreadId: "thread-1"
      })
    );
  });

  test("migrates legacy bindings when platform ownership is unambiguous", async () => {
    const statePath = createStatePath();
    writeState(statePath, {
      schemaVersion: 2,
      threadBindings: {
        "123": {
          codexThreadId: "thread-1",
          cwd: "/repo-a"
        }
      }
    });

    const store = new StateStore(statePath, {
      bots: {
        "discord-default": {
          platform: "discord"
        }
      }
    });

    await store.load();

    expect(store.getBinding("123")).toBeNull();
    expect(store.getBinding("bot:discord-default:route:123")).toEqual(
      expect.objectContaining({
        botId: "discord-default",
        platform: "discord",
        externalRouteId: "123",
        repoChannelId: "bot:discord-default:route:123",
        codexThreadId: "thread-1",
        cwd: "/repo-a"
      })
    );
  });

  test("drops ambiguous legacy bindings when multiple platform bots exist", async () => {
    const statePath = createStatePath();
    writeState(statePath, {
      schemaVersion: 2,
      threadBindings: {
        "123": {
          codexThreadId: "thread-1",
          cwd: "/repo-a"
        }
      }
    });

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message ?? ""));
    };

    try {
      const store = new StateStore(statePath, {
        bots: {
          "discord-main": {
            platform: "discord"
          },
          "discord-review": {
            platform: "discord"
          }
        }
      });

      await store.load();

      expect(store.snapshot().threadBindings).toEqual({});
      expect(warnings.some((line) => line.includes("ambiguous legacy binding"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});
