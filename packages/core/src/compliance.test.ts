import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseComplianceRegistry,
  standardFor,
  requiredChecks,
  CRITICALITY_LEVELS,
  type ComplianceRegistry,
} from './compliance.js';

function makeStandard(over: Record<string, unknown> = {}) {
  return {
    description: 'x',
    checks: {
      lintTypecheck: true,
      unitTests: true,
      minCoveragePct: null,
      integrationTests: false,
      e2eRecette: false,
      secretScan: true,
      dependencyAudit: false,
      sast: false,
      pentest: false,
      loadTest: false,
      p95LatencyMs: null,
    },
    audit: { auditors: 1, tier: 'cheap' as const },
    soc2ControlReview: false,
    humanRecetteSignoff: false,
    ...over,
  };
}

function makeRegistry(): ComplianceRegistry {
  return parseComplianceRegistry({
    version: 'test',
    levels: {
      low: makeStandard(),
      medium: makeStandard({
        checks: { ...makeStandard().checks, minCoveragePct: 70, integrationTests: true },
      }),
      high: makeStandard({ audit: { auditors: 1, tier: 'frontier' }, soc2ControlReview: true }),
      critical: makeStandard({
        checks: { ...makeStandard().checks, pentest: true, loadTest: true, p95LatencyMs: 1000 },
        audit: { auditors: 2, tier: 'frontier' },
      }),
    },
  });
}

describe('parseComplianceRegistry', () => {
  it('accepts a well-formed registry with all four levels', () => {
    const r = makeRegistry();
    expect(Object.keys(r.levels).sort()).toEqual([...CRITICALITY_LEVELS].sort());
  });

  it('rejects a missing level', () => {
    expect(() =>
      parseComplianceRegistry({ version: 'x', levels: { low: makeStandard() } }),
    ).toThrow();
  });

  it('rejects an out-of-range coverage threshold', () => {
    expect(() =>
      parseComplianceRegistry({
        version: 'x',
        levels: {
          low: makeStandard({ checks: { ...makeStandard().checks, minCoveragePct: 150 } }),
          medium: makeStandard(),
          high: makeStandard(),
          critical: makeStandard(),
        },
      }),
    ).toThrow();
  });

  it('rejects an unknown auditor tier', () => {
    expect(
      () =>
        makeStandard({ audit: { auditors: 1, tier: 'mid' } }) &&
        parseComplianceRegistry({
          version: 'x',
          levels: {
            low: makeStandard({ audit: { auditors: 1, tier: 'mid' } }),
            medium: makeStandard(),
            high: makeStandard(),
            critical: makeStandard(),
          },
        }),
    ).toThrow();
  });
});

describe('requiredChecks', () => {
  it('lists enabled checks with thresholds and escalates with criticality', () => {
    const r = makeRegistry();
    expect(requiredChecks(r, 'low')).toEqual(['lintTypecheck', 'unitTests', 'secretScan']);
    expect(requiredChecks(r, 'medium')).toContain('coverage>=70');
    expect(requiredChecks(r, 'medium')).toContain('integrationTests');
    expect(requiredChecks(r, 'critical')).toContain('pentest');
    expect(requiredChecks(r, 'critical')).toContain('loadTest(p95<=1000ms)');
  });
});

describe('standardFor', () => {
  it('returns the audit requirement for a level', () => {
    const r = makeRegistry();
    expect(standardFor(r, 'critical').audit).toEqual({ auditors: 2, tier: 'frontier' });
    expect(standardFor(r, 'low').audit.tier).toBe('cheap');
  });
});

describe('shipped config/compliance-standards.json', () => {
  it('is present and validates against the schema', () => {
    const path = fileURLToPath(
      new URL('../../../config/compliance-standards.json', import.meta.url),
    );
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const registry = parseComplianceRegistry(raw);
    // sanity: standards must not weaken as criticality rises (coverage monotonic-ish, audits non-decreasing)
    expect(registry.levels.critical.audit.auditors).toBeGreaterThanOrEqual(
      registry.levels.high.audit.auditors,
    );
    expect(registry.levels.critical.checks.pentest).toBe(true);
    expect(registry.levels.low.checks.pentest).toBe(false);
  });
});
