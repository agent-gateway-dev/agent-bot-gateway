export type CodexNotificationKind = "agent_delta" | "item_lifecycle" | "turn_completed" | "error" | "unknown";

export type CodexItemLifecycleState = "started" | "completed";

export interface CodexNotificationBase {
  kind: CodexNotificationKind;
  method: string;
  threadId: string | null;
}

export interface CodexAgentDeltaNotification extends CodexNotificationBase {
  kind: "agent_delta";
  delta: string;
}

export interface CodexItemLifecycleNotification extends CodexNotificationBase {
  kind: "item_lifecycle";
  state: CodexItemLifecycleState;
  item?: Record<string, unknown>;
}

export interface CodexTurnCompletedNotification extends CodexNotificationBase {
  kind: "turn_completed";
}

export interface CodexErrorNotification extends CodexNotificationBase {
  kind: "error";
  errorMessage: string;
}

export interface CodexUnknownNotification extends CodexNotificationBase {
  kind: "unknown";
}

export type CodexNormalizedNotification =
  | CodexAgentDeltaNotification
  | CodexItemLifecycleNotification
  | CodexTurnCompletedNotification
  | CodexErrorNotification
  | CodexUnknownNotification;
