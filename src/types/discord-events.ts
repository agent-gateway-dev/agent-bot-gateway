export type DiscordRouteKind = "command" | "chat_prompt" | "approval_interaction";

export interface DiscordRouteBase {
  kind: DiscordRouteKind;
  channelId: string;
  authorId: string;
}

export interface DiscordCommandRoute extends DiscordRouteBase {
  kind: "command";
  command: string;
  raw: string;
}

export interface DiscordChatPromptRoute extends DiscordRouteBase {
  kind: "chat_prompt";
  text: string;
}

export interface DiscordApprovalInteractionRoute extends DiscordRouteBase {
  kind: "approval_interaction";
  token: string;
  decision: "accept" | "decline" | "cancel";
}

export type DiscordNormalizedRoute =
  | DiscordCommandRoute
  | DiscordChatPromptRoute
  | DiscordApprovalInteractionRoute;
