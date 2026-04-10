import { z } from 'zod';
import type { PaperclipClient } from '../paperclip-client.js';

export const backofficeTicketStatusSchema = z.object({
  ticketId: z.string().describe('The ticket ID to check (e.g., "ABC-123")'),
});

export type BackofficeTicketStatusInput = z.infer<typeof backofficeTicketStatusSchema>;

export async function backofficeTicketStatus(
  input: BackofficeTicketStatusInput,
  paperclip: PaperclipClient,
) {
  const issue = await paperclip.getIssue(input.ticketId);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            id: issue.id,
            shortId: issue.shortId,
            title: issue.title,
            status: issue.status,
            assignee: issue.assigneeAgentId,
            priority: issue.priority,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
          },
          null,
          2,
        ),
      },
    ],
  };
}
