import pino from 'pino';

const logger = pino({ name: 'paperclip-client' });

export interface PaperclipClientConfig {
  apiUrl: string;
  apiKey?: string;
}

export class PaperclipClient {
  private readonly apiUrl: string;
  private readonly apiKey: string | undefined;

  constructor(config: PaperclipClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  async createIssue(params: {
    companyId: string;
    title: string;
    status: string;
    description?: string;
    assigneeAgentId?: string;
    priority?: string;
  }): Promise<Record<string, unknown>> {
    return this.request('POST', `/companies/${params.companyId}/issues`, {
      title: params.title,
      status: params.status,
      description: params.description,
      assigneeAgentId: params.assigneeAgentId,
      priority: params.priority,
    });
  }

  async getIssue(issueId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/issues/${issueId}`);
  }

  /** Update an issue (e.g. status transition for the approval gate). */
  async updateIssue(
    issueId: string,
    body: { status?: string; comment?: string },
  ): Promise<Record<string, unknown>> {
    return this.request('PATCH', `/issues/${issueId}`, body);
  }

  /** List a company's issues (used to discover pending approval requests).
   * Tolerates array or { issues | data } envelope shapes. */
  async listCompanyIssues(companyId: string): Promise<Array<Record<string, unknown>>> {
    const raw = (await this.request('GET', `/companies/${companyId}/issues`)) as unknown;
    return (
      Array.isArray(raw)
        ? raw
        : ((raw as { issues?: unknown[] })?.issues ?? (raw as { data?: unknown[] })?.data ?? [])
    ) as Array<Record<string, unknown>>;
  }

  async addComment(issueId: string, body: string): Promise<{ id: string }> {
    return this.request('POST', `/issues/${issueId}/comments`, { body });
  }

  async listAgents(companyId: string): Promise<Array<Record<string, unknown>>> {
    return this.request('GET', `/companies/${companyId}/agents`);
  }

  /** List a company's routines (official processes / Capability B). */
  async listRoutines(companyId: string): Promise<Array<Record<string, unknown>>> {
    return this.request('GET', `/companies/${companyId}/routines`);
  }

  /** Trigger a routine run. `variables` (string/number/boolean) and `payload`
   * map to the routine run contract; an idempotencyKey avoids duplicate runs. */
  async runRoutine(
    routineId: string,
    body?: {
      payload?: Record<string, unknown>;
      variables?: Record<string, string | number | boolean>;
      idempotencyKey?: string;
    },
  ): Promise<Record<string, unknown>> {
    const hasBody = body && (body.payload || body.variables || body.idempotencyKey);
    return this.request('POST', `/routines/${routineId}/run`, hasBody ? body : undefined);
  }

  /** List a routine's runs — used to resolve the issue Paperclip links to a freshly
   * triggered run. Tolerates array or { runs | data } envelope shapes. */
  async listRoutineRuns(routineId: string): Promise<Array<Record<string, unknown>>> {
    const raw = (await this.request('GET', `/routines/${routineId}/runs`)) as unknown;
    return (
      Array.isArray(raw)
        ? raw
        : ((raw as { runs?: unknown[] })?.runs ?? (raw as { data?: unknown[] })?.data ?? [])
    ) as Array<Record<string, unknown>>;
  }

  async getAgent(agentId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/agents/${agentId}`);
  }

  async health(): Promise<{ status: string }> {
    const res = await fetch(`${this.apiUrl}/health`);
    return (await res.json()) as { status: string };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.apiUrl}/api${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    logger.debug({ method, path }, 'Paperclip API request');

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Paperclip API ${method} ${path} failed: ${response.status} — ${errorText}`);
    }

    const text = await response.text();
    if (!text) return null as T;
    return JSON.parse(text) as T;
  }
}
