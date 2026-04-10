import { z } from 'zod';

export const EvtEventSchema = z.object({
  type: z.string(),
  actor: z.string(),
  scope: z.string().optional(),
  payload: z.record(z.unknown()),
  timestamp: z.string().datetime().optional(),
});

export type EvtEvent = z.infer<typeof EvtEventSchema>;

export const BACKOFFICE_EVENT_PREFIXES = {
  invoice: 'backoffice.invoice',
  contract: 'backoffice.contract',
  consistency: 'backoffice.consistency',
  digest: 'backoffice.digest',
  process: 'backoffice.process',
  notify: 'backoffice.notify',
  hr: 'backoffice.hr',
  data: 'backoffice.data',
  evolution: 'backoffice.evolution',
  deal: 'backoffice.deal',
  payment: 'backoffice.payment',
  sales: 'backoffice.sales',
  finance: 'backoffice.finance',
} as const;

export type BackofficeEventType =
  (typeof BACKOFFICE_EVENT_PREFIXES)[keyof typeof BACKOFFICE_EVENT_PREFIXES];
