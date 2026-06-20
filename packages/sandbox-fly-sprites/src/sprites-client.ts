/**
 * Thin REST client for the Fly Sprites API (https://api.sprites.dev/v1).
 *
 * We call the documented REST surface directly (rather than the @fly/sprites SDK)
 * to keep the dependency surface small and the requests fully testable. Response
 * shapes for exec/filesystem are tolerated defensively and MUST be verified against
 * the live API at Phase A4 (no live calls run in CI).
 */
export interface SpritesClientOptions {
  token: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_BASE_URL = 'https://api.sprites.dev/v1';

export class SpritesClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SpritesClientOptions) {
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Build an absolute API URL for a sprite path. Exposed for tests. */
  url(spritePath: string): string {
    return `${this.baseUrl}${spritePath}`;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchImpl(this.url(path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => '');
      throw new Error(`Sprites API ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return res;
  }

  /** Create (provision) a sprite by name. Idempotent on the API side. */
  async createSprite(
    name: string,
    opts: { image?: string | null; region?: string },
  ): Promise<void> {
    await this.request('POST', '/sprites', {
      name,
      ...(opts.image ? { image: opts.image } : {}),
      ...(opts.region ? { region: opts.region } : {}),
    });
  }

  /** Return the sprite, or null if it no longer exists. */
  async getSprite(name: string): Promise<Record<string, unknown> | null> {
    const res = await this.request('GET', `/sprites/${encodeURIComponent(name)}`);
    if (res.status === 404) return null;
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }

  async destroySprite(name: string): Promise<void> {
    await this.request('DELETE', `/sprites/${encodeURIComponent(name)}`);
  }

  /** Run a shell command in the sprite. `command` is a full shell script. */
  async exec(name: string, command: string, timeoutMs?: number): Promise<ExecResult> {
    const res = await this.request('POST', `/sprites/${encodeURIComponent(name)}/exec`, {
      cmd: command,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
      stdout: typeof raw.stdout === 'string' ? raw.stdout : '',
      stderr: typeof raw.stderr === 'string' ? raw.stderr : '',
      timedOut: raw.timedOut === true,
    };
  }

  async writeFile(name: string, path: string, content: string): Promise<void> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    await this.request('POST', `/sprites/${encodeURIComponent(name)}/filesystem/${encoded}`, {
      content,
    });
  }

  async readFile(name: string, path: string): Promise<string> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await this.request(
      'GET',
      `/sprites/${encodeURIComponent(name)}/filesystem/${encoded}`,
    );
    if (res.status === 404) throw new Error(`File not found: ${path}`);
    return await res.text();
  }
}
