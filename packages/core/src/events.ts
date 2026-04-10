import { z } from 'zod';

// Aligned with gs-stream-events SDK (packages/sdk/src/types.ts)
export const EvtSourceSchema = z.object({
  application: z.string(),
  version: z.string(),
  environment: z.enum(['development', 'staging', 'production']),
});

export const EvtActorSchema = z.object({
  userId: z.string(),
  accountId: z.string(),
  role: z.string().optional(),
});

export const EvtScopeSchema = z.object({
  accountId: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
});

export const EvtEventSchema = z.object({
  eventId: z.string().optional(),
  eventType: z.string(),
  timestamp: z.union([z.date(), z.string()]).optional(),
  source: EvtSourceSchema,
  actor: EvtActorSchema,
  scope: EvtScopeSchema,
  payload: z.record(z.unknown()),
  metadata: z.record(z.unknown()).optional(),
});

export type EvtEvent = z.infer<typeof EvtEventSchema>;
export type EvtSource = z.infer<typeof EvtSourceSchema>;
export type EvtActor = z.infer<typeof EvtActorSchema>;
export type EvtScope = z.infer<typeof EvtScopeSchema>;

// Query types (matching EVT API)
export interface EvtQueryParams {
  filters?: {
    eventTypes?: string[];
    applications?: string[];
    accountIds?: string[];
  };
  timeRange?: {
    from?: Date | string;
    to?: Date | string;
  };
  limit?: number;
  cursor?: string;
}

export interface EvtQueryResult {
  events: EvtEvent[];
  total?: number;
  limit: number;
  cursor?: string;
  hasMore?: boolean;
}

// Backoffice event type constants
export const BACKOFFICE_EVENT_TYPES = {
  // Invoice
  'invoice.draft_created': 'backoffice.invoice.draft_created',
  'invoice.approved': 'backoffice.invoice.approved',
  'invoice.sent': 'backoffice.invoice.sent',

  // Contract
  'contract.registered': 'backoffice.contract.registered',
  'contract.signed': 'backoffice.contract.signed',

  // Consistency
  'consistency.alert': 'backoffice.consistency.alert',
  'consistency.check_completed': 'backoffice.consistency.check_completed',

  // Digest
  'digest.published': 'backoffice.digest.published',

  // Process
  'process.updated': 'backoffice.process.updated',
  'process.created': 'backoffice.process.created',

  // Notifications
  'notify.google_chat': 'backoffice.notify.google_chat',
  'notify.email': 'backoffice.notify.email',

  // HR
  'hr.deadline_approaching': 'backoffice.hr.deadline_approaching',
  'hr.onboarding_started': 'backoffice.hr.onboarding_started',

  // Data
  'data.query_completed': 'backoffice.data.query_completed',

  // Sales
  'deal.updated': 'backoffice.deal.updated',
  'deal.won': 'backoffice.deal.won',

  // Finance
  'payment.received': 'backoffice.payment.received',
  'payment.overdue': 'backoffice.payment.overdue',
} as const;

export type BackofficeEventType =
  (typeof BACKOFFICE_EVENT_TYPES)[keyof typeof BACKOFFICE_EVENT_TYPES];

// Helper to create a backoffice event
export function createBackofficeEvent(
  eventType: string,
  actor: EvtActor,
  scope: EvtScope,
  payload: Record<string, unknown>,
  environment: 'development' | 'staging' | 'production' = 'development',
): EvtEvent {
  return {
    eventType,
    source: {
      application: 'gs-backoffice',
      version: '0.1.0',
      environment,
    },
    actor,
    scope,
    payload,
  };
}
