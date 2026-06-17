import type { RBACConfig } from '@gs-backoffice/core';
import { describe, expect, it } from 'vitest';
import { RBACResolver } from './rbac.js';

const config: RBACConfig = {
  groups: {
    Sales: {
      services: { notion: { actions: ['read'], scopes: ['Commercial'] } },
      workflows: [],
    },
  },
};

// Minimal stand-in for JumpCloudClient — only getUserGroupsByEmail is used by resolve().
type JcCtor = ConstructorParameters<typeof RBACResolver>[0];
function fakeJumpCloud(getUserGroupsByEmail: (email: string) => Promise<unknown>): JcCtor {
  return { getUserGroupsByEmail } as unknown as JcCtor;
}

describe('RBACResolver (fail-closed)', () => {
  it('denies all access when the user is not found in JumpCloud', async () => {
    const resolver = new RBACResolver(
      fakeJumpCloud(async () => null),
      config,
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
    );
    const ctx = await resolver.resolve('u1', 'x@grand-shooting.com');
    expect(ctx.permissions).toEqual([]);
    expect(ctx.scopes).toEqual({});
  });

  it("denies all access when the user's groups match nothing in the RBAC config", async () => {
    const resolver = new RBACResolver(
      fakeJumpCloud(async () => ({
        user: { username: 'nobody' },
        groups: [{ name: 'UnmappedGroup' }],
      })),
      config,
    );
    const ctx = await resolver.resolve('u1', 'x@grand-shooting.com');
    expect(ctx.permissions).toEqual([]);
    expect(ctx.groups).toEqual(['UnmappedGroup']);
  });

  it('grants the mapped permissions and scopes for a known group', async () => {
    const resolver = new RBACResolver(
      fakeJumpCloud(async () => ({
        user: { username: 'jdoe' },
        groups: [{ name: 'Sales' }],
      })),
      config,
    );
    const ctx = await resolver.resolve('u1', 'sales@grand-shooting.com');
    expect(ctx.permissions).toContain('notion.read');
    expect(ctx.scopes.notion).toContain('Commercial');
  });
});
