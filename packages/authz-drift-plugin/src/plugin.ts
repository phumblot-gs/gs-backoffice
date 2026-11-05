import { definePlugin, type PluginContext } from '@paperclipai/plugin-sdk';
import { loadAgentsAuthz } from '@gs-backoffice/core';
import { EvtClient } from '@gs-backoffice/evt-client';
import { JOB_FAILURE_MARKER, runDriftCheck, type EvtTarget } from './check.js';
import type { ReadOnlyPaperclip } from './collect.js';

const DEFAULT_AUTHZ_PATH = '/opt/gs-agent-tools/agents-authz.json';

/** Narrow the SDK context to the read-only surface the collector uses. */
export function readOnlyPaperclip(ctx: PluginContext): ReadOnlyPaperclip {
  return {
    companies: {
      get: async (id) => (await ctx.companies.get(id)) as unknown as Record<string, unknown> | null,
    },
    agents: {
      list: async (input) =>
        (await ctx.agents.list(input)) as unknown as Array<Record<string, unknown>>,
    },
    authorization: {
      grants: {
        list: async (input) =>
          (await ctx.authorization.grants.list(input)) as unknown as Array<{
            permissionKey: string;
            scope?: Record<string, unknown> | null;
          }>,
      },
    },
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** EVT credentials: secret reference first (never logged), then the legacy env. */
async function resolveEvt(
  ctx: PluginContext,
  cfg: Record<string, unknown>,
  companyId: string,
): Promise<EvtTarget | undefined> {
  const baseUrl = str(cfg.evtApiUrl) || str(process.env.EVT_API_URL);
  const accountId = str(cfg.evtAccountId) || str(process.env.EVT_ACCOUNT_ID);
  let apiKey = '';
  const ref = cfg.evtApiKey;
  if (ref && (typeof ref === 'string' || typeof ref === 'object')) {
    try {
      apiKey = str(
        await ctx.secrets.resolve(ref as Parameters<typeof ctx.secrets.resolve>[0], { companyId }),
      );
      if (apiKey)
        ctx.logger.info('secret resolved from the Paperclip store', { refKey: 'evtApiKey' });
    } catch (err) {
      ctx.logger.warn('evtApiKey reference could not be resolved — falling back to the env', {
        error: String(err),
      });
    }
  }
  apiKey ||= str(process.env.EVT_API_KEY);
  if (!baseUrl || !accountId || !apiKey) return undefined;
  const client = new EvtClient({ baseUrl, apiKey });
  return { accountId, publish: (event) => client.publish(event) };
}

/**
 * Registers the daily (and on-demand) drift check. A scheduled job carries no company,
 * so it enumerates the companies visible to the plugin and checks every one whose
 * plugin config names an `environment`. No configured company at all is a failure,
 * not a silent no-op.
 */
const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register('authz-drift-check', async (job) => {
      const companies = await ctx.companies.list();
      let checked = 0;
      for (const company of companies) {
        const cfg = (await ctx.config.get(company.id).catch(() => ({}))) as Record<string, unknown>;
        const environment = str(cfg.environment);
        if (environment !== 'staging' && environment !== 'production') {
          ctx.logger.info('authz-drift-check: company has no environment configured — skipped', {
            companyId: company.id,
          });
          continue;
        }
        checked++;
        const path = str(cfg.authzPath) || DEFAULT_AUTHZ_PATH;
        const res = await runDriftCheck({
          paperclip: readOnlyPaperclip(ctx),
          companyId: company.id,
          environment,
          loadConfig: () => loadAgentsAuthz(path),
          evt: await resolveEvt(ctx, cfg, company.id),
          chatScope: str(cfg.chatScope) || 'leadership',
          logger: ctx.logger,
          trigger: job.trigger,
        });
        ctx.logger.info('authz-drift-check: run complete', {
          companyId: company.id,
          environment,
          ok: res.ok,
          counts: res.summary?.counts,
          published: res.published,
          publishFailures: res.publishFailures,
        });
      }
      if (checked === 0) {
        ctx.logger.error(
          `${JOB_FAILURE_MARKER} authz-drift-check: no company has the plugin configured with an environment — nothing was checked`,
        );
      }
    });
  },
});

export default plugin;
