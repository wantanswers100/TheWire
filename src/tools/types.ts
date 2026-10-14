// Tool Registry types — Wire Platform
// Tools are named, typed capabilities that agents can invoke via structured calls.

export interface ToolParameterSchema {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  required?: boolean;
  items?: ToolParameterSchema;            // for type=array
  properties?: Record<string, ToolParameterSchema>; // for type=object
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameterSchema>;
  requiresHitl: boolean;     // true → HITL approval gate before execution
  enabled: boolean;
  execute: (args: Record<string, unknown>) => Promise<ToolCallResult>;
}

export interface ToolCallRequest {
  tool: string;
  args: Record<string, unknown>;
  requestId?: string;
}

export type ToolCallResult =
  | { ok: true; output: string; requestId?: string }
  | { ok: false; error: string; requestId?: string };
