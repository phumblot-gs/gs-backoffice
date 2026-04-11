import type { AgentRoleType } from './agents.js';

export interface DataSourcePermissions {
  read: boolean;
  scopes?: string[];
  eventTypes?: string[];
  databases?: string[];
}

export interface RBACGroupConfig {
  dataSources: Record<string, DataSourcePermissions>;
  agents: AgentRoleType[];
}

export interface RBACConfig {
  groups: Record<string, RBACGroupConfig>;
}
