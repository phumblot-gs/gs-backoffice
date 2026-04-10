import { z } from 'zod';

export const backofficeDigestSchema = z.object({
  period: z
    .enum(['daily', 'weekly', 'monthly'])
    .optional()
    .describe('Digest period (defaults to weekly)'),
});

export type BackofficeDigestInput = z.infer<typeof backofficeDigestSchema>;

export async function backofficeDigest(input: BackofficeDigestInput) {
  const period = input.period ?? 'weekly';

  // Phase 2: placeholder — will be populated by Chief of Staff heartbeat
  return {
    content: [
      {
        type: 'text' as const,
        text: `[${period} digest] No digest available yet. The Chief of Staff produces digests on its Friday 9:00 heartbeat. Full digest support coming in Phase 3.`,
      },
    ],
  };
}
