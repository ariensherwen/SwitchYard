export type PiLifecycleEvent =
  | "session_start"
  | "turn_start"
  | "turn_end"
  | "agent_end"
  | "agent_settled"
  | "session_shutdown"
  | "tool_call";

export interface PiExtensionContext {
  shutdown(): void;
  isIdle(): boolean;
}

export interface PiToolDefinition<TParams> {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    id: string,
    params: TParams,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: PiExtensionContext,
  ): unknown | Promise<unknown>;
}

export interface PiExtensionApi {
  registerTool<TParams>(tool: PiToolDefinition<TParams>): void;
  on(
    event: PiLifecycleEvent,
    handler: (event?: unknown, ctx?: PiExtensionContext) => unknown | Promise<unknown>,
  ): void;
  sendUserMessage(
    message: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ): void | Promise<void>;
  setActiveTools(toolNames: string[]): void;
}
