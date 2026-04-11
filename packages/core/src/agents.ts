import { z } from 'zod';

export const AgentRole = z.enum([
  'chief-of-staff',
  'methods-officer',
  'data-officer',
  'finance',
  'hr',
  'sales-ops',
]);

export type AgentRoleType = z.infer<typeof AgentRole>;

export const AGENT_ROLES: Record<AgentRoleType, { name: string; reportsTo: AgentRoleType | null }> =
  {
    'chief-of-staff': { name: 'Chef de Cabinet', reportsTo: null },
    'methods-officer': { name: 'Responsable Méthodes', reportsTo: 'chief-of-staff' },
    'data-officer': { name: 'Responsable Données', reportsTo: 'chief-of-staff' },
    finance: { name: 'Responsable Finance', reportsTo: 'chief-of-staff' },
    hr: { name: 'Responsable RH', reportsTo: 'chief-of-staff' },
    'sales-ops': { name: 'Sales Ops', reportsTo: 'chief-of-staff' },
  };
