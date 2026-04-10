import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PaperclipClient } from './paperclip-client.js';
import type { RBACResolver } from './auth/rbac.js';
import { backofficeAskSchema, backofficeAsk } from './tools/backoffice-ask.js';
import {
  backofficeStartWorkflowSchema,
  backofficeStartWorkflow,
} from './tools/backoffice-start-workflow.js';
import {
  backofficeTicketStatusSchema,
  backofficeTicketStatus,
} from './tools/backoffice-ticket-status.js';
import {
  backofficeTicketUpdateSchema,
  backofficeTicketUpdate,
} from './tools/backoffice-ticket-update.js';
import { backofficeDataQuerySchema, backofficeDataQuery } from './tools/backoffice-data-query.js';
import { backofficeDigestSchema, backofficeDigest } from './tools/backoffice-digest.js';

export interface McpServerConfig {
  paperclip: PaperclipClient;
  rbacResolver: RBACResolver;
  companyId: string;
  chiefOfStaffAgentId: string;
}

export function createBackofficeMcpServer(config: McpServerConfig): McpServer {
  const server = new McpServer({
    name: 'gs-backoffice',
    version: '0.1.0',
  });

  server.tool(
    'backoffice_ask',
    'Ask any question about internal processes. The Chief of Staff will route it to the right agent.',
    backofficeAskSchema.shape,
    async (input) => {
      const parsed = backofficeAskSchema.parse(input);
      return backofficeAsk(parsed, config.paperclip, config.companyId, config.chiefOfStaffAgentId);
    },
  );

  server.tool(
    'backoffice_start_workflow',
    'Start a business workflow (e.g., "invoice client X", "register contract").',
    backofficeStartWorkflowSchema.shape,
    async (input) => {
      const parsed = backofficeStartWorkflowSchema.parse(input);
      return backofficeStartWorkflow(
        parsed,
        config.paperclip,
        config.companyId,
        config.chiefOfStaffAgentId,
      );
    },
  );

  server.tool(
    'backoffice_ticket_status',
    'Check the status of an existing back office ticket.',
    backofficeTicketStatusSchema.shape,
    async (input) => {
      const parsed = backofficeTicketStatusSchema.parse(input);
      return backofficeTicketStatus(parsed, config.paperclip);
    },
  );

  server.tool(
    'backoffice_ticket_update',
    'Add information or a message to an existing ticket.',
    backofficeTicketUpdateSchema.shape,
    async (input) => {
      const parsed = backofficeTicketUpdateSchema.parse(input);
      return backofficeTicketUpdate(parsed, config.paperclip);
    },
  );

  server.tool(
    'backoffice_data_query',
    'Query data from company registries (HubSpot, Hyperline, Pennylane, etc.). Access is controlled by your JumpCloud group membership.',
    backofficeDataQuerySchema.shape,
    async (input) => {
      const parsed = backofficeDataQuerySchema.parse(input);
      // TODO: resolve actual user ID from MCP session auth
      const rbac = await config.rbacResolver.resolve('dev-user');
      return backofficeDataQuery(parsed, rbac);
    },
  );

  server.tool(
    'backoffice_digest',
    'Get the latest internal digest (weekly summary of activity across all departments).',
    backofficeDigestSchema.shape,
    async (input) => {
      const parsed = backofficeDigestSchema.parse(input);
      return backofficeDigest(parsed);
    },
  );

  return server;
}
