import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashName } from '../src/ghosts.js';
import { applyCensus, decodeInput, exitCode, readManifest } from '../src/scan.js';

const namesFromFile = (file, text) => readManifest(file, text).names;

test('a requirements file is recognised by more than its exact name', () => {
  for (const file of ['dev-requirements.txt', 'reqs.txt', 'requirements.in', 'requirements/dev.txt']) {
    assert.deepEqual(namesFromFile(file, 'flask==3.0\n').map(({ name }) => name), ['flask'], file);
  }
});

test('a named requirements file is read even with a line pip would reject', () => {
  assert.deepEqual(namesFromFile('requirements.txt', 'flask\nnot a real line\n').map(({ name }) => name), ['flask', 'not']);
});

test('an unreadable input can never come out clean, but real trouble still wins', () => {
  assert.equal(exitCode([{ state: 'alive' }], 1), 2);
  assert.equal(exitCode([{ state: 'ghost' }], 1), 1);
  assert.equal(exitCode([{ state: 'alive' }], 0), 0);
});

test('piped content is recognised by what it contains', () => {
  assert.deepEqual(namesFromFile(undefined, 'flask==3.0\nrequests\n'), [{ eco: 'pip', name: 'flask' }, { eco: 'pip', name: 'requests' }]);
  assert.deepEqual(namesFromFile(undefined, '{"dependencies":{"a":"1"}}'), [{ eco: 'npm', name: 'a' }]);
  assert.deepEqual(namesFromFile('package.prod.json', '{"dependencies":{"b":"1"}}'), [{ eco: 'npm', name: 'b' }]);
});

test('requirements: paths, archives and direct URLs never reach the index', () => {
  const text = 'vendor/foo-1.0.whl\nC:\\pkgs\\foo.whl\nfile:./x\nfoo-1.0.tar.gz\nthing @ https://x.test/t.whl\nflask\n';
  assert.deepEqual(namesFromFile('requirements.txt', text).map(({ name }) => name), ['flask']);
});

test('requirements: a marker with a URL in it keeps the package', () => {
  assert.deepEqual(namesFromFile('requirements.txt', 'flask; extra == "https://x.test"\n').map(({ name }) => name), ['flask']);
});

test('requirements: continuations are joined the way pip joins them', () => {
  assert.deepEqual(namesFromFile('requirements.txt', 'ev\\\nil-pkg\n').map(({ name }) => name), ['evil-pkg']);
  assert.deepEqual(namesFromFile('requirements.txt', 'flask==3.0 \\\n    --hash=sha256:abc\n').map(({ name }) => name), ['flask']);
});

test('requirements: includes are reported so they can be followed', () => {
  assert.deepEqual(readManifest('requirements.txt', '-r base.txt\n--requirement=other.txt\n').includes, ['base.txt', 'other.txt']);
});

test('a dist tag that starts with git is not a git dependency', () => {
  assert.deepEqual(namesFromFile('package.json', '{"dependencies":{"a":"gitly"}}'), [{ eco: 'npm', name: 'a' }]);
});

test('an answer that contains a manifest has that manifest read', () => {
  const json = 'Add this:\n```json\n{"dependencies":{"from-json":"1.0.0"}}\n```\n';
  const reqs = 'Put this in requirements.txt:\n```\nfrom-reqs==1.0\n```\n';
  const tagged = 'Like so:\n```requirements\nfrom-tagged\n```\n';
  assert.deepEqual(namesFromFile('answer.md', json), [{ eco: 'npm', name: 'from-json' }]);
  assert.deepEqual(namesFromFile('answer.md', reqs), [{ eco: 'pip', name: 'from-reqs' }]);
  assert.deepEqual(namesFromFile('answer.md', tagged), [{ eco: 'pip', name: 'from-tagged' }]);
});

test('an unpinned one-word code block in an answer is not a requirement', () => {
  assert.deepEqual(namesFromFile('answer.md', 'Output:\n```\nhello\n```\n'), []);
});

test('invalid JSON is an error, not an empty manifest', () => {
  assert.throws(() => readManifest('package.json', '{nope'), /not valid JSON/);
  assert.throws(() => readManifest('other.json', '{nope'), /not valid JSON/);
  assert.throws(() => readManifest('package.json', 'null'), /not a package manifest/);
});

test('a package.json with no dependencies is a manifest with nothing in it', () => {
  assert.deepEqual(readManifest('package.json', '{"name":"x"}'), { kind: 'npm', names: [], includes: [] });
});

test('decodes the encodings Windows tools write', () => {
  const little = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('flask\r\n', 'utf16le')]);
  const big = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('flask\r\n', 'utf16le').swap16()]);
  assert.equal(decodeInput(little), 'flask\r\n');
  assert.equal(decodeInput(big), 'flask\r\n');
  assert.equal(decodeInput(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), '{}');
  assert.equal(decodeInput(Buffer.from('plain')), 'plain');
});

test('a file with NUL bytes and no byte order mark is refused', () => {
  assert.throws(() => decodeInput(Buffer.from('flask', 'utf16le')), /binary/);
});

test('a census ghost that is now deprecated is still possessed', () => {
  const census = { takenAt: '2026-10-31T00:00:00.000Z', hashes: { [hashName('npm', 'x')]: { runs: 1 } } };
  assert.equal(applyCensus({ eco: 'npm', name: 'x', state: 'dead' }, census).state, 'possessed');
});
