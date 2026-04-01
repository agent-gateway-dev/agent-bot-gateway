import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadRuntimeBootstrapConfig } from "../src/app/loadRuntimeBootstrapConfig.js";

const ENV_KEYS = [
  "CHANNEL_CONFIG_PATH",
  "STATE_PATH",
  "DISCORD_BOT_TOKEN",
  "DISCORD_BOT_TOKEN_MAIN",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_APP_ID_MAIN",
  "FEISHU_APP_SECRET_MAIN",
  "FEISHU_VERIFICATION_TOKEN",
  "FEISHU_VERIFICATION_TOKEN_MAIN",
  "DISCORD_ALLOWED_USER_IDS",
  "FEISHU_ALLOWED_OPEN_IDS",
  "CONFIG_GOVERNANCE_MODE"
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const ORIGINAL_EXIT = process.exit;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.CONFIG_GOVERNANCE_MODE = "warn";
  process.env.DISCORD_BOT_TOKEN = "";
  process.env.FEISHU_APP_ID = "";
  process.env.FEISHU_APP_SECRET = "";
  process.exit = ((code?: string | number | null | undefined) => {
    throw new Error(`process.exit:${code ?? "0"}`);
  }) as typeof process.exit;
});

afterEach(() => {
  process.exit = ORIGINAL_EXIT;
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function writeJsonTempFile(payload: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-bridge-bootstrap-multibot-"));
  const filePath = path.join(dir, "channels.json");
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

function createTempStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-bridge-bootstrap-state-"));
  return path.join(dir, "state.json");
}

describe("loadRuntimeBootstrapConfig multi-bot", () => {
  test("loads credentials from bot auth env references", async () => {
    process.env.CHANNEL_CONFIG_PATH = writeJsonTempFile({
      bots: {
        "discord-codex-main": {
          platform: "discord",
          runtime: "codex",
          auth: {
            tokenEnv: "DISCORD_BOT_TOKEN_MAIN"
          },
          routes: {
            "123": {
              cwd: "./repo-a"
            }
          }
        }
      }
    });
    process.env.STATE_PATH = createTempStatePath();
    process.env.DISCORD_BOT_TOKEN_MAIN = "token-1";

    const bootstrap = await loadRuntimeBootstrapConfig();

    expect(bootstrap.config.bots["discord-codex-main"]?.auth).toEqual({
      tokenEnv: "DISCORD_BOT_TOKEN_MAIN",
      token: "token-1"
    });
  });

  test("keeps legacy env-only startup working when bots config is absent", async () => {
    process.env.CHANNEL_CONFIG_PATH = writeJsonTempFile({});
    process.env.STATE_PATH = createTempStatePath();
    process.env.DISCORD_BOT_TOKEN = "legacy-token";

    const bootstrap = await loadRuntimeBootstrapConfig();

    expect(bootstrap.config.bots["discord-default"]?.auth).toEqual({
      tokenEnv: "DISCORD_BOT_TOKEN",
      token: "legacy-token"
    });
  });
});
