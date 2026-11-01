import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Runs the real CLI on a copy that looks like a fresh clone. Every case here
// stops before any registry lookup, so these need no network.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), 'ghostdeps-cli-'));
cpSync(join(ROOT, 'src'), join(WORK, 'src'), { recursive: true });
mkdirSync(join(WORK, 'data'));
mkdirSync(join(WORK, 'docs'));
const CENSUS = JSON.stringify({ takenAt: '2026-10-31T00:00:00.000Z', hashes: { abc: { runs: 1 } } });
const SUMMARY = '{"models":{}}';
writeFileSync(join(WORK, 'data/ghosts.json'), CENSUS);
writeFileSync(join(WORK, 'data/summary.json'), SUMMARY);
after(() => rmSync(WORK, { recursive: true, force: true }));

const cli = (args, input = '') => spawnSync(process.execPath, ['src/cli.js', ...args], { cwd: WORK, input, encoding: 'utf8', timeout: 15_000 });
const write = (name, content) => writeFileSync(join(WORK, name), content);

test('empty stdin is not clean', () => {
  const { status, stdout } = cli(['check']);
  assert.equal(status, 2);
  assert.doesNotMatch(stdout, /checked:/);
});

test('input with no names in it is not clean', () => {
  assert.equal(cli(['check'], 'Hello, this is only a sentence.\n').status, 2);
});

test('a missing file is exit 2 with no stack trace', () => {
  const { status, stderr } = cli(['check', 'missing.json']);
  assert.equal(status, 2);
  assert.match(stderr, /Could not read missing\.json: no such file/);
  assert.doesNotMatch(stderr, /node:internal/);
});

test('invalid JSON is exit 2 with no stack trace', () => {
  write('bad.json', '{nope');
  const { status, stderr } = cli(['check', 'bad.json']);
  assert.equal(status, 2);
  assert.doesNotMatch(stderr, /node:internal/);
});

test('a UTF-8 BOM does not break a package.json', () => {
  write('package.json', '﻿{"name":"x"}');
  const { status, stdout } = cli(['check', 'package.json']);
  assert.equal(status, 0);
  assert.match(stdout, /No registry packages listed/);
});

test('an empty requirements file is not clean', () => {
  write('requirements.txt', '   \n');
  assert.equal(cli(['check', 'requirements.txt']).status, 2);
});

test('a real manifest with no dependencies is clean', () => {
  write('package.json', '{"name":"x"}');
  assert.equal(cli(['check', 'package.json']).status, 0);
});

test('one unreadable file among several is not clean', () => {
  write('package.json', '{"name":"x"}');
  assert.equal(cli(['check', 'package.json', 'missing.json']).status, 2);
});

test('an include that cannot be followed is not clean', () => {
  assert.equal(cli(['check'], '-r base.txt\n').status, 2);
  write('requirements.txt', '-r missing-base.txt\n');
  const { status, stderr } = cli(['check', 'requirements.txt']);
  assert.equal(status, 2);
  assert.match(stderr, /missing-base\.txt/);
});

test('a circular include ends', () => {
  write('requirements.txt', '-r other.txt\n');
  write('other.txt', '-r requirements.txt\n');
  const { status, signal } = cli(['check', 'requirements.txt']);
  assert.equal(signal, null);
  assert.equal(status, 0);
});

test('analyze with no local data leaves the published census alone', () => {
  const { status, stderr } = cli(['analyze']);
  assert.equal(status, 2);
  assert.match(stderr, /left alone/);
  assert.equal(readFileSync(join(WORK, 'data/ghosts.json'), 'utf8'), CENSUS);
  assert.equal(readFileSync(join(WORK, 'data/summary.json'), 'utf8'), SUMMARY);
});

test('report with no primary sweep explains itself', () => {
  const { status, stderr } = cli(['report']);
  assert.equal(status, 2);
  assert.match(stderr, /no gemma3:4b sweep/);
  assert.doesNotMatch(stderr, /node:internal/);
});
