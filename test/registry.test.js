import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, classifyAll } from '../src/registry.js';

const NOW = Date.parse('2026-10-31T00:00:00Z');

function stub(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    for (const [fragment, reply] of Object.entries(routes)) {
      if (!url.includes(fragment)) continue;
      if (reply instanceof Error) throw reply;
      const { status = 200, body = {} } = reply;
      return { status, ok: status >= 200 && status < 300, json: async () => body };
    }
    throw new Error(`Unexpected request to ${url}`);
  };
  return { fetchImpl, calls };
}

const npmDoc = (overrides = {}) => ({
  'dist-tags': { latest: '1.0.0' },
  versions: { '1.0.0': {} },
  time: { created: '2019-01-01T00:00:00.000Z' },
  ...overrides,
});

const run = (eco, name, routes) => classify(eco, name, { ...stub(routes), now: NOW });

test('npm: a 404 is a ghost', async () => {
  assert.equal((await run('npm', 'x', { 'registry.npmjs.org': { status: 404 } })).state, 'ghost');
});

test('a ghost confirmed by deps.dev is corroborated', async () => {
  const verdict = await run('npm', 'x', { 'registry.npmjs.org': { status: 404 }, 'api.deps.dev': { status: 404 } });
  assert.deepEqual(verdict, { state: 'ghost', corroborated: true });
});

test('a 404 that deps.dev remembers is a tombstone, on either registry', async () => {
  const memory = { 'api.deps.dev': { body: { versions: [{ versionKey: {} }] } } };
  assert.equal((await run('npm', 'x', { 'registry.npmjs.org': { status: 404 }, ...memory })).state, 'tombstone');
  assert.equal((await run('pip', 'x', { 'pypi.org': { status: 404 }, ...memory })).state, 'tombstone');
});

test('a deps.dev record with no versions proves nothing', async () => {
  const verdict = await run('npm', 'x', { 'registry.npmjs.org': { status: 404 }, 'api.deps.dev': { body: { versions: [] } } });
  assert.equal(verdict.state, 'ghost');
});

test('deps.dev being down leaves the 404 standing but unconfirmed', async () => {
  const verdict = await run('pip', 'x', { 'pypi.org': { status: 404 }, 'api.deps.dev': { status: 503 } });
  assert.deepEqual(verdict, { state: 'ghost', corroborated: false });
});

test('deps.dev is asked about the right ecosystem and encoded name', async () => {
  const { fetchImpl, calls } = stub({ 'registry.npmjs.org': { status: 404 }, 'pypi.org': { status: 404 }, 'api.deps.dev': { status: 404 } });
  await classify('npm', '@scope/thing', { fetchImpl, now: NOW });
  await classify('pip', 'some-name', { fetchImpl, now: NOW });
  assert.equal(calls[1], 'https://api.deps.dev/v3/systems/npm/packages/%40scope%2Fthing');
  assert.equal(calls[3], 'https://api.deps.dev/v3/systems/pypi/packages/some-name');
});

test('npm: an old package is alive', async () => {
  assert.equal((await run('npm', 'x', { 'registry.npmjs.org': { body: npmDoc() } })).state, 'alive');
});

test('npm: a rate limit is unknown, never a ghost', async () => {
  assert.equal((await run('npm', 'x', { 'registry.npmjs.org': { status: 429 } })).state, 'unknown');
});

test('npm: a server error is unknown', async () => {
  assert.equal((await run('npm', 'x', { 'registry.npmjs.org': { status: 503 } })).state, 'unknown');
});

test('npm: a network failure is unknown', async () => {
  assert.equal((await run('npm', 'x', { 'registry.npmjs.org': new Error('ECONNRESET') })).state, 'unknown');
});

test('npm: unpublished is a tombstone', async () => {
  const body = { time: { created: '2019-01-01T00:00:00.000Z', unpublished: { time: '2024-02-03T00:00:00.000Z' } } };
  const verdict = await run('npm', 'x', { 'registry.npmjs.org': { body } });
  assert.equal(verdict.state, 'tombstone');
  assert.match(verdict.detail, /2024-02-03/);
});

test('npm: a security holding package is exorcised', async () => {
  const body = npmDoc({ 'dist-tags': { latest: '0.0.2-security' }, versions: { '0.0.2-security': {} }, description: 'security holding package' });
  assert.equal((await run('npm', 'x', { 'registry.npmjs.org': { body } })).state, 'exorcised');
});

test('npm: a -security tag without the holding text is not exorcised', async () => {
  const body = npmDoc({ 'dist-tags': { latest: '2.0.0-security' }, versions: { '2.0.0-security': {} }, description: 'a security scanner' });
  assert.equal((await run('npm', 'x', { 'registry.npmjs.org': { body } })).state, 'alive');
});

test('npm: deprecated is dead', async () => {
  const body = npmDoc({ versions: { '1.0.0': { deprecated: 'use something else' } } });
  assert.equal((await run('npm', 'x', { 'registry.npmjs.org': { body } })).state, 'dead');
});

test('npm: young and unused is possessed', async () => {
  const body = npmDoc({ time: { created: '2026-09-01T00:00:00.000Z' } });
  const verdict = await run('npm', 'x', { 'api.npmjs.org': { body: { downloads: 12 } }, 'registry.npmjs.org': { body } });
  assert.equal(verdict.state, 'possessed');
  assert.equal(verdict.downloads, 12);
});

test('npm: young and popular is alive', async () => {
  const body = npmDoc({ time: { created: '2026-09-01T00:00:00.000Z' } });
  const verdict = await run('npm', 'x', { 'api.npmjs.org': { body: { downloads: 90_000 } }, 'registry.npmjs.org': { body } });
  assert.equal(verdict.state, 'alive');
});

test('npm: young with no download data is unknown, not alive', async () => {
  const body = npmDoc({ time: { created: '2026-09-01T00:00:00.000Z' } });
  const verdict = await run('npm', 'x', { 'api.npmjs.org': { status: 503 }, 'registry.npmjs.org': { body } });
  assert.equal(verdict.state, 'unknown');
});

test('npm: scoped names are encoded for the registry', async () => {
  const { fetchImpl, calls } = stub({ 'registry.npmjs.org': { status: 404 } });
  await classify('npm', '@scope/thing', { fetchImpl, now: NOW });
  assert.equal(calls[0], 'https://registry.npmjs.org/@scope%2fthing');
});

const pypiFile = (upload, yanked = false) => ({ upload_time_iso_8601: upload, yanked });

test('pip: a 404 is a ghost', async () => {
  assert.equal((await run('pip', 'x', { 'pypi.org': { status: 404 } })).state, 'ghost');
});

test('pip: a rate limit is unknown', async () => {
  assert.equal((await run('pip', 'x', { 'pypi.org': { status: 429 } })).state, 'unknown');
});

test('pip: an old project is alive', async () => {
  const body = { info: {}, releases: { '1.0': [pypiFile('2018-01-01T00:00:00Z')] } };
  assert.equal((await run('pip', 'x', { 'pypi.org': { body } })).state, 'alive');
});

test('pip: age comes from the first upload, not the latest', async () => {
  const body = { info: {}, releases: { '1.0': [pypiFile('2018-01-01T00:00:00Z')], '1.1': [pypiFile('2026-10-01T00:00:00Z')] } };
  assert.equal((await run('pip', 'x', { 'pypi.org': { body } })).state, 'alive');
});

test('pip: young with few releases is possessed', async () => {
  const body = { info: {}, releases: { '0.1': [pypiFile('2026-10-01T00:00:00Z')] } };
  assert.equal((await run('pip', 'x', { 'pypi.org': { body } })).state, 'possessed');
});

test('pip: young with many releases is alive', async () => {
  const releases = Object.fromEntries([1, 2, 3, 4].map((n) => [`0.${n}`, [pypiFile('2026-10-01T00:00:00Z')]]));
  assert.equal((await run('pip', 'x', { 'pypi.org': { body: { info: {}, releases } } })).state, 'alive');
});

test('pip: every release yanked is a tombstone', async () => {
  const body = { info: {}, releases: { '1.0': [pypiFile('2018-01-01T00:00:00Z', true)] } };
  assert.equal((await run('pip', 'x', { 'pypi.org': { body } })).state, 'tombstone');
});

test('pip: a project with no files is a tombstone', async () => {
  const body = { info: {}, releases: { '1.0': [] } };
  assert.equal((await run('pip', 'x', { 'pypi.org': { body } })).state, 'tombstone');
});

test('npm: deprecating a new, unused package does not dodge possessed', async () => {
  const body = npmDoc({ time: { created: '2026-10-26T00:00:00.000Z' }, versions: { '1.0.0': { deprecated: 'old' } } });
  const verdict = await run('npm', 'x', { 'api.npmjs.org': { body: { downloads: 0 } }, 'registry.npmjs.org': { body } });
  assert.equal(verdict.state, 'possessed');
});

test('npm: a new, popular, deprecated package is dead', async () => {
  const body = npmDoc({ time: { created: '2026-10-26T00:00:00.000Z' }, versions: { '1.0.0': { deprecated: 'old' } } });
  const verdict = await run('npm', 'x', { 'api.npmjs.org': { body: { downloads: 90_000 } }, 'registry.npmjs.org': { body } });
  assert.equal(verdict.state, 'dead');
  assert.equal(verdict.downloads, 90_000);
});

test('pip: yanking the latest release does not dodge possessed', async () => {
  const body = { info: { yanked: true }, releases: { '0.1': [pypiFile('2026-10-26T00:00:00Z')], '0.2': [pypiFile('2026-10-27T00:00:00Z', true)] } };
  assert.equal((await run('pip', 'x', { 'pypi.org': { body } })).state, 'possessed');
});

test('pip: an old project with its latest release yanked is dead', async () => {
  const body = { info: { yanked: true }, releases: { '0.1': [pypiFile('2018-01-01T00:00:00Z')], '0.2': [pypiFile('2018-02-01T00:00:00Z', true)] } };
  assert.equal((await run('pip', 'x', { 'pypi.org': { body } })).state, 'dead');
});

test('classifyAll asks once per name and reuses the cache', async () => {
  const { fetchImpl, calls } = stub({ 'registry.npmjs.org': { status: 404 } });
  const cache = new Map();
  const items = [{ eco: 'npm', name: 'a' }, { eco: 'npm', name: 'b' }];
  await classifyAll(items, { fetchImpl, now: NOW, cache });
  const results = await classifyAll(items, { fetchImpl, now: NOW, cache });
  assert.equal(calls.filter((url) => url.includes('registry.npmjs.org')).length, 2);
  assert.deepEqual(results.map((item) => item.state), ['ghost', 'ghost']);
});
