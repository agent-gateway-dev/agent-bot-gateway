declare module "*config/loadConfig.js" {
  export interface LoadedChannelSetup {
    cwd: string;
    model?: string;
  }

  export interface LoadedConfig {
    channels: Record<string, LoadedChannelSetup>;
    defaultModel: string;
    defaultEffort: string;
    approvalPolicy: string;
    sandboxMode: string;
    allowedUserIds: string[];
    autoDiscoverProjects: boolean;
  }

  export function loadConfig(
    filePath: string,
    options?: { defaultModel?: string; defaultEffort?: string }
  ): Promise<LoadedConfig>;
}
