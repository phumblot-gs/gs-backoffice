import type { PaperclipPluginManifestV1 } from '@paperclipai/plugin-sdk';

const PLUGIN_ID = 'gs-backoffice.fly-sprites-sandbox-provider';
const PLUGIN_VERSION = '0.1.0';

/**
 * Sandbox provider plugin that runs agent code in Fly Sprites — Firecracker
 * microVMs with EU regions, hibernate-when-idle, and fast checkpoints. Registered
 * as the `fly-sprites` environment driver; the driver is lease-based (see plugin.ts).
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: 'Fly Sprites Sandbox Provider',
  description:
    'Provisions Fly Sprites (Firecracker microVMs) as isolated Paperclip execution environments.',
  author: 'GRAFMAKER',
  categories: ['automation'],
  capabilities: ['environment.drivers.register'],
  entrypoints: {
    worker: './dist/worker.js',
  },
  environmentDrivers: [
    {
      driverKey: 'fly-sprites',
      kind: 'sandbox_provider',
      displayName: 'Fly Sprites',
      description:
        'Runs commands in a Fly Sprite (Firecracker microVM). Sprites hibernate when idle and wake on demand, so leases can be reused cheaply.',
      configSchema: {
        type: 'object',
        properties: {
          apiKey: {
            type: 'string',
            format: 'secret-ref',
            description:
              'Fly Sprites API token (from sprites.dev). Paste a value or a Paperclip secret reference; falls back to SPRITES_TOKEN if omitted.',
          },
          region: {
            type: 'string',
            description: "Fly region to pin the Sprite to (e.g. 'cdg' Paris, 'fra' Frankfurt).",
            default: 'cdg',
          },
          image: {
            type: 'string',
            description: 'Base image/template for the Sprite. Defaults to the provider default.',
          },
          timeoutMs: {
            type: 'number',
            description: 'Per-command timeout in milliseconds. Defaults to 1 hour.',
            default: 3600000,
          },
          reuseLease: {
            type: 'boolean',
            description:
              'Reuse a hibernated Sprite across runs instead of destroying it on release.',
            default: true,
          },
        },
      },
    },
  ],
};

export default manifest;
