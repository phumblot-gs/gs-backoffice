import { describe, it, expect } from 'vitest';
import {
  buildGitCredentialSetup,
  buildCheckoutScript,
  buildCodeTaskCheckoutScript,
  SANDBOX_WORK_DIR,
} from './sandbox.js';
import { spriteNameForKey, parseSandboxRunParams, parseCodeTaskParams } from './tools.js';

describe('buildGitCredentialSetup', () => {
  it('uses a credential helper reading $GH_TOKEN (no token in url/config)', () => {
    const s = buildGitCredentialSetup();
    expect(s).toContain('credential.helper');
    expect(s).toContain('password=$GH_TOKEN');
    expect(s).not.toMatch(/https:\/\/[^@\s]*@/); // never embeds a token in a URL
  });
});

describe('buildCheckoutScript', () => {
  it('reuses the clone only when origin matches (repo-match guard), else re-clones', () => {
    const s = buildCheckoutScript({
      repoUrl: 'https://github.com/org/repo.git',
      ref: 'main',
      workDir: SANDBOX_WORK_DIR,
    });
    expect(s).toContain('git remote get-url origin');
    expect(s).toContain("'https://github.com/org/repo.git'");
    expect(s).toContain('git clone');
    expect(s).toContain('git fetch origin --prune');
    // checks out the ref, with a branch-tracking fallback
    expect(s).toContain("git checkout --quiet 'main'");
    expect(s).toContain("origin/'main'");
  });

  it('shell-quotes a ref to resist injection', () => {
    const s = buildCheckoutScript({ repoUrl: 'r', ref: 'x; rm -rf /', workDir: '/w' });
    expect(s).toContain(`'x; rm -rf /'`);
    expect(s).not.toMatch(/checkout --quiet x; rm/);
  });
});

describe('spriteNameForKey', () => {
  it('produces a valid lowercase Fly sprite name', () => {
    expect(spriteNameForKey('audit-GRA-12')).toBe('sandbox-audit-gra-12');
    expect(spriteNameForKey('Proj/Repo #1')).toBe('sandbox-proj-repo-1');
    expect(spriteNameForKey('')).toBe('sandbox-default');
    expect(spriteNameForKey('audit-GRA-12')).toMatch(/^sandbox-[a-z0-9-]+$/);
  });
});

describe('parseSandboxRunParams', () => {
  it('accepts a complete payload', () => {
    const r = parseSandboxRunParams({
      sandboxKey: 'audit-1',
      repoUrl: 'https://x/r.git',
      ref: 'feat/x',
      command: 'pnpm test',
      credMode: 'read_only',
      timeoutMs: 60000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.credMode).toBe('read_only');
      expect(r.value.timeoutMs).toBe(60000);
    }
  });

  it('defaults credMode to read_only and drops invalid timeout', () => {
    const r = parseSandboxRunParams({
      sandboxKey: 'k',
      repoUrl: 'u',
      ref: 'r',
      command: 'c',
      timeoutMs: -5,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.credMode).toBe('read_only');
      expect(r.value.timeoutMs).toBeUndefined();
    }
  });

  it('rejects missing required params', () => {
    const r = parseSandboxRunParams({ sandboxKey: 'k', repoUrl: 'u', ref: 'r' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/command/);
  });
});

describe('buildCodeTaskCheckoutScript', () => {
  it('continues an existing target branch, else branches from base', () => {
    const s = buildCodeTaskCheckoutScript({
      repoUrl: 'https://github.com/org/repo.git',
      baseBranch: 'main',
      targetBranch: 'eng/x',
      workDir: SANDBOX_WORK_DIR,
    });
    expect(s).toContain('git clone');
    expect(s).toContain('git remote get-url origin');
    expect(s).toContain('refs/remotes/origin/$TB'); // continue target branch if it exists
    expect(s).toContain('git checkout -B "$TB" "origin/$TB"');
    expect(s).toContain('git checkout -B "$TB" "origin/$BB"'); // else from base
    expect(s).toContain('credential.helper');
  });
});

describe('parseCodeTaskParams', () => {
  it('accepts a complete payload', () => {
    const r = parseCodeTaskParams({
      sandboxKey: 'eng-1',
      repoUrl: 'https://x/r.git',
      baseBranch: 'develop',
      targetBranch: 'eng/feat',
      task: 'add a file',
      model: 'claude-x',
      timeoutMs: 120000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.baseBranch).toBe('develop');
      expect(r.value.targetBranch).toBe('eng/feat');
      expect(r.value.timeoutMs).toBe(120000);
    }
  });

  it('defaults baseBranch to main', () => {
    const r = parseCodeTaskParams({ sandboxKey: 'k', repoUrl: 'u', targetBranch: 't', task: 'do' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.baseBranch).toBe('main');
  });

  it('rejects missing task', () => {
    const r = parseCodeTaskParams({ sandboxKey: 'k', repoUrl: 'u', targetBranch: 't' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/task/);
  });
});
