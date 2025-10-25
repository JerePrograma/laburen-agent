export type ConversationRole = "user" | "assistant";

export interface ClientMessage {
  id: string;
  role: ConversationRole;
  content: string;
  streaming?: boolean;
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ClientThought {
  id: string;
  text: string;
}

export interface ClientToolCall {
  id: string;
  name: string;
  input: unknown;
  result?: unknown;
  status: "pending" | "success" | "error";
  error?: string;
}

export type ClientTimelineItem =
  | ({ kind: "message" } & ClientMessage)
  | ({ kind: "thought" } & ClientThought)
  | ({ kind: "tool" } & ClientToolCall)
  | ({ kind: "error"; id: string; text: string });

export interface AgentEventHandler {
  onThought(id: string, text: string): void;
  onToolCall(event: ClientToolCall): void;
  onToolResult(event: ClientToolCall): void;
  onAssistantMessage(id: string): void;
  onAssistantToken(id: string, value: string): void;
  onError(text: string): void;
  onState(state: AgentStateUpdate): void;
}

export interface AgentStateUpdate {
  authenticatedUser?: {
    id: number;
    name: string;
  } | null;
}
