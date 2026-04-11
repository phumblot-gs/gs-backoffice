import { z } from 'zod';
import type { PaperclipClient } from '../paperclip-client.js';

export const backofficeStartWorkflowSchema = z.object({
  workflow: z.string().describe('Name of the workflow to start (e.g., "invoice client X")'),
  parameters: z.record(z.string()).optional().describe('Key-value parameters for the workflow'),
  notes: z.string().optional().describe('Additional notes for the workflow'),
});

export type BackofficeStartWorkflowInput = z.infer<typeof backofficeStartWorkflowSchema>;

export async function backofficeStartWorkflow(
  input: BackofficeStartWorkflowInput,
  paperclip: PaperclipClient,
  companyId: string,
  chiefOfStaffAgentId: string,
) {
  const paramsList = input.parameters
    ? Object.entries(input.parameters)
        .map(([k, v]) => `- **${k}:** ${v}`)
        .join('\n')
    : '';

  const issue = await paperclip.createIssue({
    companyId,
    title: `Workflow: ${input.workflow.slice(0, 180)}`,
    description: [
      `**Workflow:** ${input.workflow}`,
      paramsList ? `\n\n**Parameters:**\n${paramsList}` : '',
      input.notes ? `\n\n**Notes:** ${input.notes}` : '',
    ].join(''),
    assigneeAgentId: chiefOfStaffAgentId,
    labels: ['workflow'],
    metadata: { workflowName: input.workflow, parameters: input.parameters },
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: `Workflow "${input.workflow}" started (ticket ${issue.shortId}). The Chief of Staff will delegate to the appropriate agent.`,
      },
    ],
  };
}
