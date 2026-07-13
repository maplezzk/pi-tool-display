import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type RuntimeToolDefinition = Record<string, unknown>;

export interface ToolDisplayAdapter {
  kind?: "read" | "edit" | "mcp" | "generic";
  overrideExistingRenderers?: boolean;
}

export interface ToolExecutionContext {
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
  signal: AbortSignal | undefined;
  onUpdate: unknown;
  ctx: ExtensionContext;
}

export type ToolExecutionMiddleware = (
  context: ToolExecutionContext,
  next: () => Promise<unknown>,
) => Promise<unknown>;

export interface ToolDisplayApi {
  version: 1;
  decorateTool<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter | Record<string, unknown>): T;
  registerExecutionMiddleware(toolName: string, middleware: ToolExecutionMiddleware): string;
}

export interface DecorateToolForDisplayOptions {
  suppressDecorateErrors?: boolean;
}

export declare function getToolDisplayApi(): ToolDisplayApi | undefined;

export declare function queueToolDisplayDecoration<T extends RuntimeToolDefinition>(
  tool: T,
  adapter?: ToolDisplayAdapter | Record<string, unknown>,
): void;

export declare function decorateToolForDisplay<T extends object>(
  tool: T,
  adapter?: ToolDisplayAdapter | Record<string, unknown>,
  options?: DecorateToolForDisplayOptions,
): T;

export declare function decorateMcpToolForDisplay<T extends RuntimeToolDefinition>(tool: T): T;

export declare function registerToolExecutionMiddleware(
  toolName: string,
  middleware: ToolExecutionMiddleware,
): string | undefined;
