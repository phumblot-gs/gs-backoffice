import { describe, it, expect } from 'vitest';
import { resolvePermissions, RBACConfigSchema } from './rbac.js';
import type { RBACConfig } from './rbac.js';

const config: RBACConfig = {
  groups: {
    Finance: {
      services: {
        notion: { actions: ['read'], scopes: ['Finance', 'Général'] },
        hyperline: { actions: ['read', 'create_invoice'], scopes: ['billing'] },
        paperclip: { actions: ['read', 'create_ticket'], scopes: ['finance'] },
      },
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
});
