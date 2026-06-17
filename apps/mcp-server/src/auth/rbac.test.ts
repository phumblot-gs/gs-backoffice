import type { PerCompanyRBACConfig } from '@gs-backoffice/core';
import { describe, expect, it } from 'vitest';
import { RBACResolver } from './rbac.js';

const SLUG = 'grafmaker';

const config: PerCompanyRBACConfig = {
  companies: {
    grafmaker: {
      name: 'GRAFMAKER',
      groups: {
        Sales: { services: { notion: { actions: ['read'], scopes: ['Sales'] } } },
      },
    },
    // A different company — its groups must NOT grant access on `grafmaker`.
    other: {
      groups: {
        Engineering: { services: { notion: { actions: ['read'], scopes: ['Engineering'] } } },
      },
    },
  },
};

// Minimal stand-in for JumpCloudClient — only getUserGroupsByEmail is used by resolve().
type JcCtor = ConstructorParameters<typeof RBACResolver>[0];
function fakeJumpCloud(getUserGroupsByEmail: (email: string) => Promise<unknown>): JcCtor {
  return { getUserGroupsByEmail } as unknown as JcCtor;
}

describe('RBACResolver (fail-closed, per-company)', () => {
  it('denies all access when the user is not found in JumpCloud', async () => {
    const resolver = new RBACResolver(
      fakeJumpCloud(async () => null),
      config,
      SLUG,
    );
    const ctx = await resolver.resolve('u1', 'ghost@grand-shooting.com');
    expect(ctx.permissions).toEqual([]);
    expect(ctx.scopes).toEqual({});
    expect(ctx.groups).toEqual([]);
  });

  it('denies all access when the JumpCloud lookup throws', async () => {
    const resolver = new RBACResolver(
      fakeJumpCloud(async () => {
        throw new Error('JumpCloud unreachable');
      }),
      config,
      SLUG,
    );
    const ctx = await resolver.resolve('u1', 'x@grand-shooting.com');
    expect(ctx.permissions).toEqual([]);
    expect(ctx.scopes).toEqual({});
  });

  it("denies all access when the user's groups match nothing on this company", async () => {
    const resolver = new RBACResolver(
      fakeJumpCloud(async () => ({ user: { username: 'x' }, groups: [{ name: 'UnmappedGroup' }] })),
      config,
      SLUG,
    );
    const ctx = await resolver.resolve('u1', 'x@grand-shooting.com');
    expect(ctx.permissions).toEqual([]);
    expect(ctx.groups).toEqual(['UnmappedGroup']);
  });

  it('grants the mapped permissions/scopes for a known group on this company', async () => {
    const resolver = new RBACResolver(
      fakeJumpCloud(async () => ({ user: { username: 'jdoe' }, groups: [{ name: 'Sales' }] })),
      config,
      SLUG,
    );
    const ctx = await resolver.resolve('u1', 'sales@grand-shooting.com');
    expect(ctx.permissions).toContain('notion.read');
    expect(ctx.scopes.notion).toContain('Sales');
  });

  it('does not leak access from another company (cross-tenant isolation)', async () => {
    // "Engineering" is only authorized on the "other" company, not on "grafmaker".
    const resolver = new RBACResolver(
      fakeJumpCloud(async () => ({ user: { username: 'eng' }, groups: [{ name: 'Engineering' }] })),
      config,
      SLUG,
    );
    const ctx = await resolver.resolve('u1', 'eng@grand-shooting.com');
    expect(ctx.permissions).toEqual([]);
    expect(ctx.scopes).toEqual({});
  });
});
