import { describe, it, expect } from 'vitest';
import { AgentRole, AGENT_ROLES } from './agents.js';

describe('AgentRole', () => {
  it('parses valid agent roles', () => {
    expect(AgentRole.parse('chief-of-staff')).toBe('chief-of-staff');
    expect(AgentRole.parse('methods-officer')).toBe('methods-officer');
    expect(AgentRole.parse('data-officer')).toBe('data-officer');
    expect(AgentRole.parse('finance')).toBe('finance');
    expect(AgentRole.parse('hr')).toBe('hr');
    expect(AgentRole.parse('sales-ops')).toBe('sales-ops');
  });

  it('rejects invalid roles', () => {
    expect(() => AgentRole.parse('invalid')).toThrow();
  });

  it('defines all 6 agents in AGENT_ROLES', () => {
    expect(Object.keys(AGENT_ROLES)).toHaveLength(6);
  });

  it('chief-of-staff has no manager', () => {
    expect(AGENT_ROLES['chief-of-staff'].reportsTo).toBeNull();
  });

  it('all other agents report to chief-of-staff', () => {
    const nonChief = Object.entries(AGENT_ROLES).filter(([role]) => role !== 'chief-of-staff');
    for (const [, config] of nonChief) {
      expect(config.reportsTo).toBe('chief-of-staff');
    }
  });
});
