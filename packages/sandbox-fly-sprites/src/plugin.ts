import { definePlugin } from '@paperclipai/plugin-sdk';
import { registerSandboxTools } from './tools.js';

// Re-export the reliable transport so the transport tests keep importing from here.
export { runScript, readRemoteFile, buildReliableExecScript } from './exec.js';

/**
 * Fly Sprites sandbox plugin — exposes the sandbox TOOLS (`sandbox_run`,
 * `sandbox_code_task`, `sandbox_release`) and the idle reaper job. The legacy
 * environment driver has been retired: agents drive the sandbox via tools (the
 * agent runs on Local and calls a tool), not by executing "on" a sandbox
 * environment. See docs/architecture/sandbox-code-tool.md.
 */
const plugin = definePlugin({
  async setup(ctx) {
    registerSandboxTools(ctx);
    ctx.logger.info('Fly Sprites sandbox plugin ready (sandbox tools + idle reaper)');
  },

  async onHealth() {
    return { status: 'ok', message: 'Fly Sprites sandbox plugin healthy' };
  },
});

export default plugin;
