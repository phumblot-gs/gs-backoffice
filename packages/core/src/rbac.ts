import type { AgentRoleType } from './agents.js';

export interface DataSourcePermissions {
  read: boolean;
  scopes: string[];
}

export interface RBACConfig {
  groups: Record<
    string,
    {
      dataSources: {
        hubspot?: DataSourcePermissions;
        hyperline?: DataSourcePermissions;
        pennylane?: DataSourcePermissions;
        linear?: DataSourcePermissions;
        evt?: { read: boolean; eventTypes: string[] };
        notion?: { read: boolean; databases: string[] };
      };
      agents: AgentRoleType[];
    }
  >;
}
