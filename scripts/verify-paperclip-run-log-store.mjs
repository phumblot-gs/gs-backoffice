import { SourceTextModule, SyntheticModule } from 'node:vm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import assert from 'node:assert/strict';
// Exercise the unmodified native implementation with an in-memory S3 provider.
// Usage: node --experimental-vm-modules scripts/verify-paperclip-run-log-store.mjs <server-dist>
import { tmpdir } from 'node:os';
const dist = process.argv[2];
if (!dist) throw new Error('Pass the Paperclip server dist directory');
const root = tmpdir();
const source = await fs.promises.readFile(path.join(dist, 'services/run-log-store.js'), 'utf8');
const mocks = {
  'node:fs': fs,
  'node:path': { default: path },
  'node:crypto': crypto,
  '../errors.js': { notFound: (msg) => Object.assign(new Error(msg), { status: 404 }) },
  '../home-paths.js': { resolvePaperclipInstanceRoot: () => root },
  '../storage/s3-provider.js': {
    createS3StorageProvider: () => {
      throw Error('Unexpected external I/O');
    },
  },
};
const module = new SourceTextModule(source);
await module.link(async (name) => {
  const obj = mocks[name];
  assert.ok(obj, name);
  return new SyntheticModule(Object.keys(obj), function () {
    for (const [k, v] of Object.entries(obj)) this.setExport(k, v);
  });
});
await module.evaluate();
const make = module.namespace.createDurableRunLogStore;
const objects = new Map();
let fail = false;
const provider = {
  async putObject({ objectKey, body }) {
    if (fail) throw Error('Synthetic storage unavailable');
    const chunks = [];
    for await (const c of body) chunks.push(c);
    objects.set(objectKey, Buffer.concat(chunks));
  },
  async headObject({ objectKey }) {
    const b = objects.get(objectKey);
    return { exists: !!b, contentLength: b?.length };
  },
  async getObject({ objectKey, range }) {
    return { stream: Readable.from([objects.get(objectKey).subarray(range.start, range.end + 1)]) };
  },
};
const base = await fs.promises.mkdtemp(root + '/log-test-');
const opts = { basePath: base, s3: { provider, keyPrefix: 'run-logs', inflightMirrorMs: 60000 } };
try {
  const store = make(opts);
  const h = await store.begin({ companyId: 'company', agentId: 'agent', runId: 'finalized' });
  await store.append(h, { ts: '2026-09-30', stream: 'stdout', chunk: 'audit fixture', seq: 1 });
  const original = await store.read(h);
  await store.finalize(h);
  await fs.promises.rm(path.join(base, h.logRef));
  const restarted = make(opts);
  assert.deepEqual(await restarted.read(h), original);
  const partial = await restarted.read(h, { offset: 5, limitBytes: 10 });
  assert.equal(partial.content, original.content.slice(5, 15));
  console.log(
    'PASS finalized log survives missing local file and new store; range reads preserved',
  );
  const live = await restarted.begin({ companyId: 'company', agentId: 'agent', runId: 'inflight' });
  await restarted.append(live, { ts: '2026-09-30', stream: 'stderr', chunk: 'in-flight audit' });
  await restarted.flushInflightMirrors();
  await fs.promises.rm(path.join(base, live.logRef));
  assert.match((await make(opts).read(live)).content, /in-flight audit/);
  console.log('PASS graceful flush preserves in-flight output');
  const broken = make({ basePath: base, s3: { provider, keyPrefix: 'run-logs' } });
  const b = await broken.begin({ companyId: 'company', agentId: 'agent', runId: 'failed-mirror' });
  await broken.append(b, { ts: '2026-09-30', stream: 'stdout', chunk: 'still local' });
  fail = true;
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    await broken.finalize(b);
  } finally {
    console.warn = warn;
  }
  assert.ok(warnings.some((s) => s.includes('[run-log-store] Failed to mirror run log')));
  assert.match((await broken.read(b)).content, /still local/);
  console.log('PASS mirror failure is observable and keeps the local run readable');
} finally {
  await fs.promises.rm(base, { recursive: true, force: true });
}
