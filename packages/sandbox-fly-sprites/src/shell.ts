/** POSIX single-quote a value for safe shell interpolation. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Valid POSIX shell env var name. */
export function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/**
 * Build a login-shell script that sources the user's profiles (and nvm) before
 * exec, so commands run with the same PATH an interactive shell sees (npm globals,
 * nvm shims, etc.) — mirrors the e2b provider's approach. `env` is interpolated
 * after profile sourcing so caller env wins. `cwd`, when given, is entered first.
 */
export function buildLoginShellScript(input: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}): string {
  const env = input.env ?? {};
  for (const key of Object.keys(env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }
  const envArgs = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const commandParts = [shellQuote(input.command), ...(input.args ?? []).map(shellQuote)].join(' ');
  const execLine =
    envArgs.length > 0 ? `exec env ${envArgs.join(' ')} ${commandParts}` : `exec ${commandParts}`;
  const lines = [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
  ];
  if (input.cwd) {
    lines.push(`cd ${shellQuote(input.cwd)}`);
  }
  lines.push(execLine);
  return lines.join(' && ');
}
