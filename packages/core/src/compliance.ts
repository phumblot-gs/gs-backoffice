import { z } from 'zod';

/**
 * Compliance registry — maps a change's **criticality** to the standards it must
 * satisfy before it can ship through the self-development loop. The Methods Officer
 * proposes a criticality in its plan; the CEO confirms it (Gate 1); the planned
 * standards then drive the verification agents (Gate 2) and the independent auditor.
 *
 * Lives as version-controlled config (`config/compliance-standards.json`, mirrored in
 * Notion for non-technical edits). This module is the schema + pure lookup helpers;
 * file loading happens at the app layer (same pattern as rbac.ts).
 */

export const CRITICALITY_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export const CriticalityLevelSchema = z.enum(CRITICALITY_LEVELS);
export type CriticalityLevel = z.infer<typeof CriticalityLevelSchema>;

/** Verification checks a change must pass. Each maps to a sandbox_run check category. */
export const ComplianceChecksSchema = z.object({
  /** Lint + typecheck must pass. */
  lintTypecheck: z.boolean(),
  /** Unit tests required for the changed logic. */
  unitTests: z.boolean(),
  /** Minimum line coverage on changed packages (null = not mandated). */
  minCoveragePct: z.number().min(0).max(100).nullable(),
  /** Integration tests must pass. */
  integrationTests: z.boolean(),
  /** End-to-end / staging recette must pass. */
  e2eRecette: z.boolean(),
  /** Secret-scanning must report clean. */
  secretScan: z.boolean(),
  /** Dependency vulnerability audit must report clean. */
  dependencyAudit: z.boolean(),
  /** Static application security testing (code scanner) must report clean. */
  sast: z.boolean(),
  /** Penetration test required. */
  pentest: z.boolean(),
  /** Load test required. */
  loadTest: z.boolean(),
  /** p95 latency budget in ms when load-tested (null = no budget set here). */
  p95LatencyMs: z.number().positive().nullable(),
});
export type ComplianceChecks = z.infer<typeof ComplianceChecksSchema>;

/** Independent-audit requirement for a criticality level. */
export const AuditRequirementSchema = z.object({
  /** Number of independent auditors (different LLM family than the implementer). 0 = none. */
  auditors: z.number().int().min(0),
  /** Auditor model tier: a cheap/fast model for routine, a frontier model for high-stakes. */
  tier: z.enum(['cheap', 'frontier']),
});
export type AuditRequirement = z.infer<typeof AuditRequirementSchema>;

export const ComplianceStandardSchema = z.object({
  /** When this level applies — guidance for proposing/confirming criticality. */
  description: z.string(),
  checks: ComplianceChecksSchema,
  audit: AuditRequirementSchema,
  /** A SOC 2 control review is required before merge. */
  soc2ControlReview: z.boolean(),
  /** A human must sign off on the staging recette before production. */
  humanRecetteSignoff: z.boolean(),
});
export type ComplianceStandard = z.infer<typeof ComplianceStandardSchema>;

export const ComplianceRegistrySchema = z.object({
  /** Registry version, bumped when standards change (for audit traceability). */
  version: z.string(),
  /** Exactly one standard per criticality level. */
  levels: z.object({
    low: ComplianceStandardSchema,
    medium: ComplianceStandardSchema,
    high: ComplianceStandardSchema,
    critical: ComplianceStandardSchema,
  }),
});
export type ComplianceRegistry = z.infer<typeof ComplianceRegistrySchema>;

/** Validate a raw (e.g. JSON-parsed) registry, throwing on a malformed config. */
export function parseComplianceRegistry(raw: unknown): ComplianceRegistry {
  return ComplianceRegistrySchema.parse(raw);
}

/** The standard mandated for a given criticality level. */
export function standardFor(
  registry: ComplianceRegistry,
  level: CriticalityLevel,
): ComplianceStandard {
  return registry.levels[level];
}

/**
 * The flat list of verification checks mandated for a level (the ones turned on),
 * as stable keys the verification agents can act on. Coverage/latency thresholds are
 * surfaced via `standardFor(...).checks` when a caller needs the numeric budget.
 */
export function requiredChecks(registry: ComplianceRegistry, level: CriticalityLevel): string[] {
  const c = registry.levels[level].checks;
  const out: string[] = [];
  if (c.lintTypecheck) out.push('lintTypecheck');
  if (c.unitTests) out.push('unitTests');
  if (c.minCoveragePct !== null) out.push(`coverage>=${c.minCoveragePct}`);
  if (c.integrationTests) out.push('integrationTests');
  if (c.e2eRecette) out.push('e2eRecette');
  if (c.secretScan) out.push('secretScan');
  if (c.dependencyAudit) out.push('dependencyAudit');
  if (c.sast) out.push('sast');
  if (c.pentest) out.push('pentest');
  if (c.loadTest)
    out.push(c.p95LatencyMs !== null ? `loadTest(p95<=${c.p95LatencyMs}ms)` : 'loadTest');
  return out;
}
