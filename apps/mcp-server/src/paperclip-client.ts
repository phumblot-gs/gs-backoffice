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
    description?: string;
    assigneeAgentId?: string;
    priority?: string;
    labels?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string; shortId: string }> {
    return this.request('POST', `/companies/${params.companyId}/issues`, {
      title: params.title,
      description: params.description,
      assigneeAgentId: params.assigneeAgentId,
      priority: params.priority,
      labels: params.labels,
      metadata: params.metadata,
    });
  }

  async getIssue(issueId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/issues/${issueId}`);
  }

  async addComment(
    issueId: string,
    body: string,
  ): Promise<{ id: string }> {
    return this.request('POST', `/issues/${issueId}/comments`, { body });
  }

  async listAgents(companyId: string): Promise<Array<Record<string, unknown>>> {
    return this.request('GET', `/companies/${companyId}/agents`);
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
