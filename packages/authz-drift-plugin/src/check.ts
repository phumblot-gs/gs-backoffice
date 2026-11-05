import {
  BACKOFFICE_EVENT_TYPES,
  compareAuthz,
  createBackofficeEvent,
  formatDriftChatMessage,
  summarizeDrift,
  type AgentsAuthz,
  type DriftSummary,
  type EnvironmentName,
  type EvtEvent,
} from '@gs-backoffice/core';
import { collectObservedState, type ReadOnlyPaperclip } from './collect.js';

/**
 * One drift-check run for one company. Read-only against Paperclip; its only outputs
 * are EVT events (`backoffice.authz.drift` per problem + one Google Chat notification
 * via `backoffice.notify.google_chat`) and log lines.
 *
 * Failure policy — loud, never silent:
 *  - invalid / missing agents-authz.json (fail-closed loader) → JOB_FAILURE_MARKER log
 *    (CloudWatch alarm → Google Chat, independent of EVT) + a chat alert when EVT is up;
 *  - Paperclip unreadable → same.
 */

/** Must stay in sync with the CloudWatch metric filter (terraform monitoring module). */
export const JOB_FAILURE_MARKER = 'BACKOFFICE_JOB_FAILURE';

export interface EvtTarget {
  accountId: string;
  publish(event: EvtEvent): Promise<unknown>;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface DriftCheckDeps {
  paperclip: ReadOnlyPaperclip;
  companyId: string;
  environment: EnvironmentName;
  /** Fail-closed loader — throws on a missing/invalid file. */
  loadConfig: () => AgentsAuthz;
  /** Undefined when EVT is not configured: the run still logs, and says it cannot alert. */
  evt: EvtTarget | undefined;
  chatScope: string;
  logger: Logger;
  trigger: string;
}

export interface DriftCheckResult {
  ok: boolean;
  summary?: DriftSummary;
  published: number;
  publishFailures: number;
  fatal?: string;
}

async function safePublish(evt: EvtTarget | undefined, event: EvtEvent): Promise<boolean> {
  if (!evt) return false;
  try {
    await evt.publish(event);
    return true;
  } catch {
    return false;
  }
}

export async function runDriftCheck(deps: DriftCheckDeps): Promise<DriftCheckResult> {
  const { environment, evt, logger } = deps;
  const accountId = evt?.accountId ?? '';
  const actor = { userId: 'authz-drift', accountId, role: 'system' };
  const chat = (text: string) =>
    createBackofficeEvent(
      BACKOFFICE_EVENT_TYPES['notify.google_chat'],
      actor,
      { accountId, resourceType: 'authz', resourceId: environment },
      { text, scope: deps.chatScope },
      environment,
    );

  let summary: DriftSummary;
  try {
    const config = deps.loadConfig();
    const state = await collectObservedState(deps.paperclip, deps.companyId, environment);
    summary = summarizeDrift(environment, compareAuthz(config, state));
  } catch (err) {
    const fatal = String((err as Error).message ?? err).slice(0, 500);
    logger.error(`${JOB_FAILURE_MARKER} authz-drift-check: cannot evaluate drift`, {
      environment,
      error: fatal,
    });
    const sent = await safePublish(
      evt,
      chat(
        `🚨 Contrôle des autorisations agents (${environment}) impossible : ${fatal}. L'état réel est INCONNU.`,
      ),
    );
    return { ok: false, published: sent ? 1 : 0, publishFailures: sent ? 0 : 1, fatal };
  }

  let published = 0;
  let publishFailures = 0;
  for (const f of summary.problems) {
    const event = createBackofficeEvent(
      BACKOFFICE_EVENT_TYPES['authz.drift'],
      actor,
      { accountId, resourceType: 'agent', resourceId: f.agentSlug ?? f.agentId ?? 'company' },
      {
        environment: f.environment,
        status: f.status,
        agentSlug: f.agentSlug,
        agentId: f.agentId ?? null,
        path: f.path,
        expected: f.expected ?? null,
        actual: f.actual ?? null,
        reason: f.reason ?? null,
        trigger: deps.trigger,
      },
      environment,
    );
    if (await safePublish(evt, event)) published++;
    else publishFailures++;
  }

  const actionable = summary.problems.filter((f) => f.status !== 'unverifiable');
  if (actionable.length > 0) {
    if (await safePublish(evt, chat(formatDriftChatMessage(summary)))) published++;
    else publishFailures++;
    // Also through CloudWatch, so a drift is never lost to an EVT outage.
    logger.error(`${JOB_FAILURE_MARKER} authz-drift-check: ${actionable.length} drift finding(s)`, {
      environment,
      counts: summary.counts,
    });
  } else {
    logger.info('authz-drift-check: no drift', { environment, counts: summary.counts });
  }
  if (!evt)
    logger.warn('authz-drift-check: EVT is not configured — findings were not published', {
      environment,
    });
  else if (publishFailures > 0)
    logger.warn('authz-drift-check: some EVT publishes failed', { publishFailures });

  return { ok: actionable.length === 0, summary, published, publishFailures };
}
