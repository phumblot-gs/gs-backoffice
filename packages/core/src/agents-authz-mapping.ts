import type { ApprovalMode } from './agents-authz.js';

/**
 * Abstract approvalMode → concrete adapterConfig values, per Paperclip adapter type.
 *
 * Only `claude_local` is VERIFIED (field present on every staging agent, 2026.824.1).
 * Paperclip 2026.824.1 has no ACPX adapter, and its OpenAPI spec / shared types carry no
 * approval key for codex_local / opencode_local (`approvalPolicy`, `permissionMode`,
 * `acpxPermissionMode`: 0 occurrences). Those adapters therefore map to `null`: the
 * drift job reports their approval mode as `unverifiable`, never `ok`. Fill a row in
 * only after reading the real key on a running instance (see the runbook).
 */
export interface ConcreteApproval {
  /** adapterConfig fields and the value each must hold. */
  adapterConfig: Record<string, unknown>;
  /** Value Paperclip assumes when the field is unset — an unset field is judged by it. */
  defaultsWhenUnset: Record<string, unknown>;
  /**
   * CLI argument sequences that must NOT appear in `adapterConfig.extraArgs` (a bypass
   * flag smuggled into extraArgs would defeat `dangerouslySkipPermissions=false`).
   */
  forbiddenArgSequences: string[][];
}

/** Every bypass sequence the collector looks for (union over adapters). */
export const KNOWN_BYPASS_SEQUENCES: string[][] = [
  ['--dangerously-skip-permissions'],
  ['--permission-mode', 'bypassPermissions'],
  ['--permission-mode=bypassPermissions'],
  ['--allow-dangerously-skip-permissions'],
];

export const APPROVAL_MODE_MAP: Record<string, Record<ApprovalMode, ConcreteApproval> | null> = {
  claude_local: {
    restricted: {
      adapterConfig: { dangerouslySkipPermissions: false },
      defaultsWhenUnset: { dangerouslySkipPermissions: true },
      forbiddenArgSequences: KNOWN_BYPASS_SEQUENCES,
    },
    // claude_local has no distinct read-only switch: read-only is enforced by the
    // `--allowedTools` list (modelled as adapter.allowedTools and drift-checked).
    read_only: {
      adapterConfig: { dangerouslySkipPermissions: false },
      defaultsWhenUnset: { dangerouslySkipPermissions: true },
      forbiddenArgSequences: KNOWN_BYPASS_SEQUENCES,
    },
    full_auto: {
      adapterConfig: { dangerouslySkipPermissions: true },
      defaultsWhenUnset: { dangerouslySkipPermissions: true },
      forbiddenArgSequences: [],
    },
  },
  // Unverified on 2026.824.1 — do not invent keys. See the runbook (upgrade section).
  codex_local: null,
  opencode_local: null,
  gemini_local: null,
  cursor: null,
  cursor_cloud: null,
};

/** The concrete expectation, or null when the adapter's mapping is unverified. */
export function concreteApproval(adapterType: string, mode: ApprovalMode): ConcreteApproval | null {
  return APPROVAL_MODE_MAP[adapterType]?.[mode] ?? null;
}

/** Whether `args` contains `seq` as a contiguous run. */
export function containsArgSequence(args: readonly string[], seq: readonly string[]): boolean {
  if (seq.length === 0) return false;
  for (let i = 0; i + seq.length <= args.length; i++) {
    if (seq.every((s, j) => args[i + j] === s)) return true;
  }
  return false;
}
