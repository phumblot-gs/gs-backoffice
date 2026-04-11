import { z } from 'zod';
import type { PaperclipClient } from '../paperclip-client.js';

export const backofficeTicketUpdateSchema = z.object({
  ticketId: z.string().describe('The ticket ID to update'),
  message: z.string().describe('Message or additional information to add to the ticket'),
});

export type BackofficeTicketUpdateInput = z.infer<typeof backofficeTicketUpdateSchema>;

export async function backofficeTicketUpdate(
  input: BackofficeTicketUpdateInput,
  paperclip: PaperclipClient,
) {
  const comment = await paperclip.addComment(input.ticketId, input.message);

  return {
    content: [
      {
        type: 'text' as const,
        text: `Comment added to ticket ${input.ticketId} (comment ${comment.id}).`,
      },
    ],
  };
}
