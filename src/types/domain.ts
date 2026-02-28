export type ChannelMode = "general" | "repo";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type ApprovalDecision = "accept" | "decline" | "cancel";

export type AttachmentIntent = "explicit_structured" | "explicit_user_request" | "inferred_text_fallback";

export type AttachmentUploadState = "queued" | "uploading" | "uploaded" | "failed";

export interface ChannelSetup {
  cwd: string;
  model?: string;
  mode: ChannelMode;
  sandboxMode: SandboxMode;
  allowFileWrites: boolean;
}

export interface ThreadBinding {
  codexThreadId: string;
  repoChannelId: string;
  cwd: string;
}

export interface RuntimePaths {
  configPath: string;
  statePath: string;
  imageCacheDir: string;
}

export interface AttachmentCandidate {
  path: string;
  intent: AttachmentIntent;
  state: AttachmentUploadState;
}
