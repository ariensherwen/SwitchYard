export type PiLifecycleEvent =
  | "session_start"
  | "turn_start"
  | "turn_end"
  | "agent_settled"
  | "session_shutdown"
  | "agent_end";

export interface PiToolDefinition<TParams> {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(id: string, params: TParams): unknown | Promise<unknown>;
}

export interface PiExtensionApi {
  registerTool<TParams>(tool: PiToolDefinition<TParams>): void;
  on(event: PiLifecycleEvent, handler: () => void | Promise<void>): void;
  sendUserMessage(message: string, options: { deliverAs: "followUp" }): void | Promise<void>;
}
