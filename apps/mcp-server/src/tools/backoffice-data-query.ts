import { z } from 'zod';
import type { RBACContext } from '../auth/rbac.js';

export const backofficeDataQuerySchema = z.object({
  query: z.string().describe('Natural language data query'),
  dataSource: z
    .enum(['hubspot', 'hyperline', 'pennylane', 'linear', 'notion'])
    .optional()
    .describe('Specific data source to query (optional — auto-routed if omitted)'),
});

export type BackofficeDataQueryInput = z.infer<typeof backofficeDataQuerySchema>;

export async function backofficeDataQuery(
  input: BackofficeDataQueryInput,
  rbac: RBACContext,
) {
  // Check RBAC permissions for the requested data source
  if (input.dataSource) {
    const sourcePerms = rbac.dataSources[input.dataSource];
    if (!sourcePerms || !sourcePerms.read) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Access denied: you do not have read access to ${input.dataSource}. Contact your administrator to request access.`,
          },
        ],
      };
    }
  }

  // Phase 2: placeholder — will be implemented with actual data source adapters
  return {
    content: [
      {
        type: 'text' as const,
        text: `[Data query received] "${input.query}"${input.dataSource ? ` (source: ${input.dataSource})` : ''}. The Data Officer will process this query and respond via your ticket. Full data query support coming in Phase 3.`,
      },
    ],
  };
}
