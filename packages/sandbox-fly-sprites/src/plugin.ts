import { randomUUID } from 'node:crypto';
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
import { parseDriverConfig, resolveApiKey, type SpriteDriverConfig } from './config.js';
import { buildLoginShellScript } from './shell.js';
import { SpritesClient } from './sprites-client.js';

const DEFAULT_REMOTE_CWD = '/home/paperclip-workspace';

function clientFor(config: SpriteDriverConfig): SpritesClient {
  return new SpritesClient({ token: resolveApiKey(config) });
}

function spriteName(): string {
  return `paperclip-${randomUUID()}`;
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
    image: input.config.image,
    reuseLease: input.config.reuseLease,
    spriteName: input.name,
    remoteCwd: input.remoteCwd,
    resumedLease: input.resumed,
  };
}

async function ensureWorkspace(
  client: SpritesClient,
  name: string,
  remoteCwd: string,
  timeoutMs: number,
): Promise<void> {
  await client.exec(
    name,
    buildLoginShellScript({ command: 'mkdir', args: ['-p', remoteCwd] }),
    timeoutMs,
  );
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
      await client.createSprite(name, { image: config.image, region: config.region });
      const result = await client.exec(
        name,
        buildLoginShellScript({ command: 'pwd' }),
        config.timeoutMs,
      );
      return {
        ok: result.exitCode === 0,
        summary: `Provisioned a Fly Sprite in ${config.region}.`,
        metadata: { provider: 'fly-sprites', region: config.region, image: config.image },
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
      await client.destroySprite(name).catch(() => undefined);
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const client = clientFor(config);
    const name = spriteName();
    try {
      await client.createSprite(name, { image: config.image, region: config.region });
      const remoteCwd = DEFAULT_REMOTE_CWD;
      await ensureWorkspace(client, name, remoteCwd, config.timeoutMs);
      return {
        providerLeaseId: name,
        metadata: leaseMetadata({ config, name, remoteCwd, resumed: false }),
      };
    } catch (error) {
      await client.destroySprite(name).catch(() => undefined);
      throw error;
    }
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    if (!params.providerLeaseId) return { providerLeaseId: null, metadata: { expired: true } };
    const config = parseDriverConfig(params.config);
    const client = clientFor(config);
    const sprite = await client.getSprite(params.providerLeaseId);
    if (!sprite) return { providerLeaseId: null, metadata: { expired: true } };
    const remoteCwd = DEFAULT_REMOTE_CWD;
    await ensureWorkspace(client, params.providerLeaseId, remoteCwd, config.timeoutMs);
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
      .destroySprite(params.providerLeaseId)
      .catch(() => undefined);
  },

  async onEnvironmentDestroyLease(params: PluginEnvironmentDestroyLeaseParams): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    await clientFor(config)
      .destroySprite(params.providerLeaseId)
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
      await ensureWorkspace(
        clientFor(config),
        params.lease.providerLeaseId,
        remoteCwd,
        config.timeoutMs,
      );
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
    const client = clientFor(config);
    const script = buildLoginShellScript({
      command: params.command,
      args: params.args ?? [],
      env: params.env,
      cwd: params.cwd,
    });
    const result = await client.exec(
      params.lease.providerLeaseId,
      script,
      params.timeoutMs ?? config.timeoutMs,
    );
    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
});

export default plugin;
