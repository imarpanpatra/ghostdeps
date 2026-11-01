import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashName, redact } from '../src/ghosts.js';
import { applyCensus, exitCode, readManifest } from '../src/scan.js';

const namesFromFile = (file, text) => readManifest(file, text).names;
const census = { takenAt: '2026-10-31T00:00:00.000Z', hashes: { [hashName('npm', 'once-a-ghost')]: { runs: 6, models: ['gemma3:4b'] } } };

test('package.json: reads every dependency group once', () => {
  const manifest = JSON.stringify({ dependencies: { a: '^1.0.0' }, devDependencies: { b: '1.0.0', a: '^1.0.0' }, peerDependencies: { c: '*' } });
  assert.deepEqual(namesFromFile('package.json', manifest).map(({ name }) => name), ['a', 'b', 'c']);
});

test('package.json: skips anything that never touches the registry', () => {
  const manifest = JSON.stringify({ dependencies: { a: 'file:../a', b: 'github:me/b', c: 'workspace:*', d: 'git+https://x.test/d.git', e: 'me/e' } });
  assert.deepEqual(namesFromFile('package.json', manifest), []);
});

test('package.json: an npm alias is checked under its real name', () => {
  const manifest = JSON.stringify({ dependencies: { nice: 'npm:real-one@1.2.3', scoped: 'npm:@acme/real-two@1' } });
  assert.deepEqual(namesFromFile('package.json', manifest).map(({ name }) => name), ['real-one', '@acme/real-two']);
});

test('requirements.txt: reads names, drops pins, comments, options and URLs', () => {
  const text = '# top\nDjango==5.0\nruamel.yaml>=0.18  # yaml\n-r other.txt\n--index-url https://x.test\nhttps://x.test/y.whl\n\nuvicorn[standard]\n';
  assert.deepEqual(namesFromFile('requirements-dev.txt', text).map(({ name }) => name), ['django', 'ruamel-yaml', 'uvicorn']);
});

test('anything else is read as a pasted model answer', () => {
  const text = 'Sure! Run:\n```bash\nnpm install pasted-one\n```\n';
  assert.deepEqual(namesFromFile('answer.md', text), [{ eco: 'npm', name: 'pasted-one' }]);
  assert.deepEqual(namesFromFile(undefined, text), [{ eco: 'npm', name: 'pasted-one' }]);
});

test('a census ghost that now exists is possessed, however old it claims to be', () => {
  const verdict = applyCensus({ eco: 'npm', name: 'once-a-ghost', state: 'alive' }, census);
  assert.equal(verdict.state, 'possessed');
  assert.match(verdict.detail, /was a ghost on 2026-10-31/);
});

test('a census ghost that is still missing stays a ghost and keeps its record', () => {
  const verdict = applyCensus({ eco: 'npm', name: 'once-a-ghost', state: 'ghost' }, census);
  assert.equal(verdict.state, 'ghost');
  assert.equal(verdict.census.runs, 6);
});

test('the census matches on ecosystem as well as name', () => {
  assert.equal(applyCensus({ eco: 'pip', name: 'once-a-ghost', state: 'alive' }, census).state, 'alive');
});

test('a name the census never saw is left alone', () => {
  assert.equal(applyCensus({ eco: 'npm', name: 'stranger', state: 'alive' }, census).state, 'alive');
});

test('exit codes keep bad news and no news apart', () => {
  assert.equal(exitCode([{ state: 'alive' }, { state: 'dead' }]), 0);
  assert.equal(exitCode([{ state: 'alive' }, { state: 'ghost' }]), 1);
  assert.equal(exitCode([{ state: 'possessed' }]), 1);
  assert.equal(exitCode([{ state: 'exorcised' }]), 1);
  assert.equal(exitCode([{ state: 'tombstone' }]), 1);
  assert.equal(exitCode([{ state: 'alive' }, { state: 'unknown' }]), 2);
  assert.equal(exitCode([{ state: 'unknown' }, { state: 'ghost' }]), 1);
});

test('redaction keeps the shape and never shows more than a third of the letters', () => {
  assert.equal(redact('some-package'), 'som█-███████');
  for (const name of ['a', 'ab', 'abc', 'fixture-pack', 'fixturename', '@scope/thing-two']) {
    const masked = redact(name);
    const shown = [...masked.slice(masked.indexOf('/') + 1)].filter((char) => /[a-z0-9]/i.test(char)).length;
    const total = name.slice(name.indexOf('/') + 1).replace(/[-_.]/g, '').length;
    assert.ok(shown <= total / 3, `${name} -> ${masked}`);
  }
});

test('redaction hides the scope too', () => {
  assert.equal(redact('@acme/pay').includes('acme'), false);
});
