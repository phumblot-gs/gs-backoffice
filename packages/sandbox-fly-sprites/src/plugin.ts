import { randomUUID } from 'node:crypto';
import WebSocketImpl from 'ws';
import { definePlugin } from '@paperclipai/plugin-sdk';
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from '@paperclipai/plugin-sdk';
import { SpritesClient, Sprite, ExecError } from '@fly/sprites';
import { parseDriverConfig, resolveApiKey, type SpriteDriverConfig } from './config.js';
import { buildLoginShellScript } from './shell.js';

// The Sprites SDK uses the global WebSocket (native on Node 22, which the Paperclip
// runtime uses). Polyfill from `ws` defensively so the provider also works if the
// worker runs on an older Node.
const g = globalThis as { WebSocket?: unknown };
if (!g.WebSocket) g.WebSocket = WebSocketImpl;

const DEFAULT_REMOTE_CWD = '/home/paperclip-workspace';

function clientFor(config: SpriteDriverConfig): SpritesClient {
  return new SpritesClient(resolveApiKey(config), { timeout: 60_000 });
}

function spriteName(): string {
  return `paperclip-${randomUUID()}`;
}

interface ExecOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a shell script in the Sprite via `sh -c`. The SDK's exec/execFile throw
 * ExecError on a non-zero exit (like child_process), so we catch it and return
 * the captured exit code + streams rather than throwing.
 */
async function runScript(sprite: Sprite, script: string): Promise<ExecOutcome> {
  try {
    const r = await sprite.execFile('sh', ['-c', script]);
    return {
      exitCode: r.exitCode,
      stdout: String(r.stdout),
      stderr: String(r.stderr),
      timedOut: false,
    };
  } catch (error) {
    if (error instanceof ExecError) {
      return {
        exitCode: error.exitCode,
        stdout: String(error.stdout),
        stderr: String(error.stderr),
        timedOut: false,
      };
    }
    throw error;
  }
}

function leaseMetadata(input: {
  config: SpriteDriverConfig;
  name: string;
  remoteCwd: string;
  resumed: boolean;
}): Record<string, unknown> {
  return {
    provider: 'fly-sprites',
    shellCommand: 'bash',
    region: input.config.region,
    reuseLease: input.config.reuseLease,
    spriteName: input.name,
    remoteCwd: input.remoteCwd,
    resumedLease: input.resumed,
  };
}

async function ensureWorkspace(sprite: Sprite, remoteCwd: string): Promise<void> {
  await runScript(sprite, buildLoginShellScript({ command: 'mkdir', args: ['-p', remoteCwd] }));
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info('Fly Sprites sandbox provider plugin ready');
  },

  async onHealth() {
    return { status: 'ok', message: 'Fly Sprites sandbox provider plugin healthy' };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseDriverConfig(params.config);
    const errors: string[] = [];
    if (config.timeoutMs < 1 || config.timeoutMs > 86_400_000) {
      errors.push('timeoutMs must be between 1 and 86400000.');
    }
    if (!config.region) {
      errors.push("A Fly region is required (e.g. 'cdg').");
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, normalizedConfig: { ...config } };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const config = parseDriverConfig(params.config);
    const client = clientFor(config);
    const name = spriteName();
    try {
      const sprite = await client.createSprite(name, { region: config.region });
      const result = await runScript(sprite, buildLoginShellScript({ command: 'pwd' }));
      return {
        ok: result.exitCode === 0,
        summary:
          result.exitCode === 0
            ? `Provisioned a Fly Sprite in ${config.region} and ran a command.`
            : `Provisioned a Fly Sprite in ${config.region} but the probe command failed (exit ${result.exitCode}).`,
        metadata: {
          provider: 'fly-sprites',
          region: config.region,
          stderr: result.stderr.slice(0, 500),
        },
      };
    } catch (error) {
      return {
        ok: false,
        summary: `Fly Sprite probe failed in ${config.region}.`,
        metadata: {
          provider: 'fly-sprites',
          region: config.region,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      await client.deleteSprite(name).catch(() => undefined);
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const client = clientFor(config);
    const name = spriteName();
    try {
      const sprite = await client.createSprite(name, { region: config.region });
      const remoteCwd = DEFAULT_REMOTE_CWD;
      await ensureWorkspace(sprite, remoteCwd);
      return {
        providerLeaseId: name,
        metadata: leaseMetadata({ config, name, remoteCwd, resumed: false }),
      };
    } catch (error) {
      await client.deleteSprite(name).catch(() => undefined);
      throw error;
    }
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    if (!params.providerLeaseId) return { providerLeaseId: null, metadata: { expired: true } };
    const config = parseDriverConfig(params.config);
    const client = clientFor(config);
    let sprite: Sprite;
    try {
      sprite = await client.getSprite(params.providerLeaseId);
    } catch {
      return { providerLeaseId: null, metadata: { expired: true } };
    }
    const remoteCwd = DEFAULT_REMOTE_CWD;
    await ensureWorkspace(sprite, remoteCwd);
    return {
      providerLeaseId: params.providerLeaseId,
      metadata: leaseMetadata({ config, name: params.providerLeaseId, remoteCwd, resumed: true }),
    };
  },

  async onEnvironmentReleaseLease(params: PluginEnvironmentReleaseLeaseParams): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    // Reuse: leave the Sprite to hibernate (0 idle cost, instant wake on resume).
    if (config.reuseLease) return;
    await clientFor(config)
      .deleteSprite(params.providerLeaseId)
      .catch(() => undefined);
  },

  async onEnvironmentDestroyLease(params: PluginEnvironmentDestroyLeaseParams): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    await clientFor(config)
      .deleteSprite(params.providerLeaseId)
      .catch(() => undefined);
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const remoteCwd =
      (typeof params.lease.metadata?.remoteCwd === 'string' && params.lease.metadata.remoteCwd) ||
      params.workspace.remotePath ||
      params.workspace.localPath ||
      DEFAULT_REMOTE_CWD;
    if (params.lease.providerLeaseId) {
      const sprite = clientFor(config).sprite(params.lease.providerLeaseId);
      await ensureWorkspace(sprite, remoteCwd);
    }
    return { cwd: remoteCwd, metadata: { provider: 'fly-sprites', remoteCwd } };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    if (!params.lease.providerLeaseId) {
      return {
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: 'No provider lease ID for execution.',
      };
    }
    const config = parseDriverConfig(params.config);
    const sprite = clientFor(config).sprite(params.lease.providerLeaseId);
    const script = buildLoginShellScript({
      command: params.command,
      args: params.args ?? [],
      env: params.env,
      cwd: params.cwd,
    });
    const result = await runScript(sprite, script);
    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
});

export default plugin;
