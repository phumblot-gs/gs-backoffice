import { describe, it, expect } from 'vitest';
import { shellQuote, isValidShellEnvKey, buildLoginShellScript } from './shell.js';

describe('shellQuote', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(shellQuote('abc')).toBe("'abc'");
    expect(shellQuote("a'b")).toBe(`'a'"'"'b'`);
  });
});

describe('isValidShellEnvKey', () => {
  it('accepts valid keys, rejects invalid', () => {
    expect(isValidShellEnvKey('GITHUB_TOKEN')).toBe(true);
    expect(isValidShellEnvKey('_x1')).toBe(true);
    expect(isValidShellEnvKey('1BAD')).toBe(false);
    expect(isValidShellEnvKey('a-b')).toBe(false);
  });
});

describe('buildLoginShellScript', () => {
  it('sources profiles then execs the quoted command', () => {
    const s = buildLoginShellScript({ command: 'pwd' });
    expect(s).toContain('/etc/profile');
    expect(s).toContain('nvm.sh');
    expect(s.trimEnd().endsWith("exec 'pwd'")).toBe(true);
  });

  it('interpolates env via `exec env KEY=val` and enters cwd', () => {
    const s = buildLoginShellScript({
      command: 'git',
      args: ['clone', 'x'],
      env: { GITHUB_TOKEN: 't/k' },
      cwd: '/work space',
    });
    expect(s).toContain("cd '/work space'");
    expect(s).toContain(`exec env GITHUB_TOKEN='t/k' 'git' 'clone' 'x'`);
  });

  it('rejects invalid env keys', () => {
    expect(() => buildLoginShellScript({ command: 'x', env: { 'BAD-KEY': '1' } })).toThrow(
      /Invalid sandbox environment variable key/,
    );
  });
});
