import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  resolvePermissions,
  resolveCompanyAccess,
  resolveAccessibleCompanies,
  canApprove,
  notifyScopeForRepo,
  RBACConfigSchema,
  PerCompanyRBACConfigSchema,
} from './rbac.js';
import type { RBACConfig, PerCompanyRBACConfig, ResolvedAccess } from './rbac.js';

describe('canApprove (approval gate 2b)', () => {
  const access = (permissions: string[], paperclipScopes: string[]): ResolvedAccess => ({
    permissions,
    scopes: { paperclip: paperclipScopes },
    workflows: [],
    agents: [],
  });

  it('denies without the paperclip.approve permission', () => {
    expect(canApprove(access(['paperclip.read'], ['*']), 'finance')).toBe(false);
  });

  it('leadership (scope *) approves any scope, including unscoped', () => {
    expect(canApprove(access(['paperclip.approve'], ['*']), 'finance')).toBe(true);
    expect(canApprove(access(['paperclip.approve'], ['*']), null)).toBe(true);
  });

  it('a scoped approver approves only its own scope', () => {
    expect(canApprove(access(['paperclip.approve'], ['finance']), 'finance')).toBe(true);
    expect(canApprove(access(['paperclip.approve'], ['finance']), 'sales')).toBe(false);
  });

  it('an unscoped process is leadership-only', () => {
    expect(canApprove(access(['paperclip.approve'], ['finance']), null)).toBe(false);
  });

  it('superuser (* permission, dev) approves anything', () => {
    expect(canApprove(access(['*'], []), 'finance')).toBe(true);
  });
});

const config: RBACConfig = {
  groups: {
    Finance: {
      services: {
        notion: { actions: ['read'], scopes: ['Finance', 'Général'] },
        hyperline: { actions: ['read', 'create_invoice'], scopes: ['billing'] },
        paperclip: { actions: ['read', 'create_ticket'], scopes: ['finance'] },
      },
      agents: ['finance-expert'],
      workflows: ['invoice_client', 'payment_followup'],
    },
    Engineering: {
      services: {
        notion: { actions: ['read'], scopes: ['Engineering', 'Général'] },
        linear: { actions: ['read', 'create_issue'] },
        paperclip: { actions: ['read'] },
      },
      workflows: ['bug_report', 'feature_request'],
    },
    Direction: {
      services: {
        notion: { actions: ['read'], scopes: ['*'] },
        paperclip: { actions: ['read', 'create_ticket', 'update_ticket'], scopes: ['*'] },
      },
      workflows: ['*'],
    },
  },
};

describe('RBACConfigSchema', () => {
  it('validates a correct config', () => {
    expect(() => RBACConfigSchema.parse(config)).not.toThrow();
  });

  it('rejects invalid config', () => {
    expect(() => RBACConfigSchema.parse({ groups: { Bad: { missing: true } } })).toThrow();
  });
});

describe('resolvePermissions', () => {
  it('resolves permissions for a single group', () => {
    const result = resolvePermissions(config, ['Finance']);
    expect(result.permissions).toContain('notion.read');
    expect(result.permissions).toContain('hyperline.read');
    expect(result.permissions).toContain('hyperline.create_invoice');
    expect(result.permissions).toContain('paperclip.read');
    expect(result.permissions).toContain('paperclip.create_ticket');
    expect(result.permissions).not.toContain('linear.read');
    expect(result.workflows).toContain('invoice_client');
    expect(result.workflows).not.toContain('bug_report');
  });

  it('merges permissions from multiple groups', () => {
    const result = resolvePermissions(config, ['Finance', 'Engineering']);
    expect(result.permissions).toContain('hyperline.read');
    expect(result.permissions).toContain('linear.read');
    expect(result.permissions).toContain('linear.create_issue');
    expect(result.workflows).toContain('invoice_client');
    expect(result.workflows).toContain('bug_report');
  });

  it('merges scopes from multiple groups', () => {
    const result = resolvePermissions(config, ['Finance', 'Engineering']);
    expect(result.scopes.notion).toContain('Finance');
    expect(result.scopes.notion).toContain('Engineering');
    expect(result.scopes.notion).toContain('Général');
  });

  it('returns empty for unknown groups', () => {
    const result = resolvePermissions(config, ['Marketing']);
    expect(result.permissions).toHaveLength(0);
    expect(result.workflows).toHaveLength(0);
    expect(Object.keys(result.scopes)).toHaveLength(0);
  });

  it('handles Direction wildcard scopes', () => {
    const result = resolvePermissions(config, ['Direction']);
    expect(result.permissions).toContain('paperclip.update_ticket');
    expect(result.scopes.notion).toContain('*');
    expect(result.workflows).toContain('*');
  });

  it('deduplicates permissions', () => {
    const result = resolvePermissions(config, ['Finance', 'Engineering']);
    const notionReadCount = result.permissions.filter((p) => p === 'notion.read').length;
    expect(notionReadCount).toBe(1);
  });

  it('resolves expert-agent grants (defaulting to empty)', () => {
    expect(resolvePermissions(config, ['Finance']).agents).toContain('finance-expert');
    expect(resolvePermissions(config, ['Engineering']).agents).toHaveLength(0);
  });
});

const perCompany: PerCompanyRBACConfig = {
  companies: {
    acme: {
      name: 'Acme',
      groups: {
        Sales: {
          services: { paperclip: { actions: ['read', 'create_ticket'], scopes: ['sales'] } },
          agents: ['sales-expert'],
          workflows: ['register_contract'],
        },
        General: {
          services: { notion: { actions: ['read'], scopes: ['General'] } },
        },
      },
    },
    globex: {
      name: 'Globex',
      groups: {
        Engineering: {
          services: { notion: { actions: ['read'], scopes: ['Engineering'] } },
          agents: ['eng-expert'],
        },
      },
    },
  },
};

describe('PerCompanyRBACConfigSchema', () => {
  it('validates a minimal per-company config (agents/workflows optional)', () => {
    expect(() =>
      PerCompanyRBACConfigSchema.parse({
        companies: { acme: { groups: { General: { services: {} } } } },
      }),
    ).not.toThrow();
  });

  it('rejects an invalid company group', () => {
    expect(() =>
      PerCompanyRBACConfigSchema.parse({ companies: { acme: { groups: { Bad: { x: 1 } } } } }),
    ).toThrow();
  });
});

describe('resolveCompanyAccess', () => {
  it('resolves access (union) for a company the user has groups in', () => {
    const r = resolveCompanyAccess(perCompany, 'acme', ['Sales', 'General']);
    expect(r.permissions).toContain('paperclip.create_ticket');
    expect(r.permissions).toContain('notion.read');
    expect(r.scopes.notion).toContain('General');
    expect(r.scopes.paperclip).toContain('sales');
    expect(r.agents).toContain('sales-expert');
    expect(r.workflows).toContain('register_contract');
  });

  it('fail-closed on an unknown company', () => {
    expect(resolveCompanyAccess(perCompany, 'unknown', ['Sales'])).toEqual({
      permissions: [],
      scopes: {},
      workflows: [],
      agents: [],
      processes: {},
    });
  });

  it('fail-closed when the user has no group authorized on the company', () => {
    // "Engineering" exists only on globex, not acme.
    expect(resolveCompanyAccess(perCompany, 'acme', ['Engineering']).permissions).toHaveLength(0);
  });

  it('does not leak access across companies', () => {
    expect(resolveCompanyAccess(perCompany, 'acme', ['Engineering']).agents).toHaveLength(0);
    expect(resolveCompanyAccess(perCompany, 'globex', ['Engineering']).agents).toContain(
      'eng-expert',
    );
  });
});

describe('resolveAccessibleCompanies', () => {
  it('lists only companies where the user has a matching group', () => {
    expect(resolveAccessibleCompanies(perCompany, ['Sales']).sort()).toEqual(['acme']);
    expect(resolveAccessibleCompanies(perCompany, ['Engineering']).sort()).toEqual(['globex']);
    expect(resolveAccessibleCompanies(perCompany, ['General', 'Engineering']).sort()).toEqual([
      'acme',
      'globex',
    ]);
    expect(resolveAccessibleCompanies(perCompany, ['Nope'])).toEqual([]);
  });
});

describe('notifyScopeForRepo', () => {
  it('returns the mapped scope (lowercased) for a known repo', () => {
    const cfg: PerCompanyRBACConfig = {
      companies: {},
      repos: { 'phumblot-gs/gs-backoffice': 'Engineering' },
    };
    expect(notifyScopeForRepo(cfg, 'phumblot-gs/gs-backoffice')).toBe('engineering');
  });

  it('defaults to "general" for an unmapped repo or when repos is absent', () => {
    expect(notifyScopeForRepo({ companies: {}, repos: {} }, 'org/other')).toBe('general');
    expect(notifyScopeForRepo({ companies: {} }, 'org/other')).toBe('general');
  });

  it('validates the shipped config/rbac.json (repos present, maps to a scope)', () => {
    const raw = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../config/rbac.json', import.meta.url)), 'utf8'),
    );
    const cfg = PerCompanyRBACConfigSchema.parse(raw);
    expect(notifyScopeForRepo(cfg, 'phumblot-gs/gs-backoffice')).toBe('general');
  });
});
