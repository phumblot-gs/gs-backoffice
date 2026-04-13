import type { z } from 'zod';
import type { EvtClient } from '@gs-backoffice/evt-client';
import type { Logger } from 'pino';

// --- Tool result (MCP compatible) ---

export type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
};

// --- Tool context (per-request employee info) ---

export interface ToolContext {
  userId: string;
  userEmail: string;
  groups: string[];
  permissions: string[];
}

// --- Plugin tool definition ---

export interface PluginTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  requiredPermission: string;
  evtEventType: string | null;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<CallToolResult>;
}

// --- Plugin initialization config ---

export interface PluginInitConfig {
  credentials: Record<string, string>;
  evtClient: EvtClient | null;
  logger: Logger;
}

// --- Service plugin interface ---

export interface ServicePlugin {
  readonly name: string;
  readonly description: string;
  readonly attributionLevel: 1 | 2;

  initialize(config: PluginInitConfig): Promise<void>;
  getTools(): PluginTool[];
}
