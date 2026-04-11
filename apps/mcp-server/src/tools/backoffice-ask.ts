import { z } from 'zod';
import type { PaperclipClient } from '../paperclip-client.js';

export const backofficeAskSchema = z.object({
  question: z.string().describe('The question to ask the back office'),
  context: z.string().optional().describe('Additional context for the question'),
  urgency: z.enum(['low', 'normal', 'high']).optional().describe('Urgency level of the question'),
});

export type BackofficeAskInput = z.infer<typeof backofficeAskSchema>;

export async function backofficeAsk(
  input: BackofficeAskInput,
  paperclip: PaperclipClient,
  companyId: string,
  chiefOfStaffAgentId: string,
) {
  const issue = await paperclip.createIssue({
    companyId,
    title: input.question.slice(0, 200),
    description: [
      `**Question:** ${input.question}`,
      input.context ? `\n**Context:** ${input.context}` : '',
      input.urgency ? `\n**Urgency:** ${input.urgency}` : '',
    ].join(''),
    assigneeAgentId: chiefOfStaffAgentId,
    priority: input.urgency === 'high' ? 'high' : 'medium',
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: `Question submitted to the back office (ticket ${issue.shortId}). The Chief of Staff will route it to the right agent and respond.`,
      },
    ],
  };
}
