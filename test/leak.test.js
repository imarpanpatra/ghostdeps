import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalize } from '../src/extract.js';
import { hashName, loadGhosts } from '../src/ghosts.js';

// Registering a ghost is the attack, so nothing git would publish may contain
// one in full. This compares every word in every file against the census hashes,
// so it runs on a fresh clone and holds no name itself.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Ghosts from the first probe, which never entered the census.
const PROBE = [
  '6119bc7b3d091f7e908ee3fc82e3309be0edaba2adf96fa1ce68d5d65e186645',
  'df41b379533e3c670c5d354c306544702ce6625d671bc6c18568160be1e4d373',
  'e7126716284c4613a0813dd0f006b38c9c4cc7606957c039c79f904d06a0c791',
  'd2fcbb87799b4f901c2c7eb5d1c3d08c75e609fd4cf40982b7980d87c40ae94c',
  'd3d6c31b99f08abae600ab2c4d77b4d52b17b3fad7f52156b626456990beb95d',
];

// The task list names the file formats it asks about, and some ghosts are just
// those words. It has to be public for anyone to reproduce the census.
const EXEMPT = new Set(['data/tasks.json']);
const LOCAL_ONLY = ['SUBMISSION.md'];

function publishedFiles() {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  return listed.split('\n').filter((file) => file && !EXEMPT.has(file) && !file.endsWith('.png'));
}

function leakedWords(text, known) {
  const words = new Set(text.match(/@?[a-z0-9][a-z0-9._/-]*[a-z0-9]|[a-z0-9]/gi) ?? []);
  return [...words].filter((word) => {
    const lower = word.toLowerCase();
    return [lower, normalize('pip', lower)].some((form) => ['npm', 'pip'].some((eco) => known.has(hashName(eco, form))));
  });
}

const known = new Set([...Object.keys(loadGhosts().hashes), ...PROBE]);

test('the census is there to compare against', () => {
  assert.ok(Object.keys(loadGhosts().hashes).length > 0);
});

test('catches a planted name in any spelling', () => {
  const planted = new Set([hashName('pip', 'plant-ed-name')]);
  assert.equal(leakedWords('see Plant_Ed.Name here', planted).length, 1);
  assert.equal(leakedWords('nothing here', planted).length, 0);
});

test('no published file contains a full ghost name', () => {
  const files = publishedFiles();
  assert.ok(files.includes('README.md') && files.some((file) => file.startsWith('test/')));
  for (const file of files) {
    assert.deepEqual(leakedWords(readFileSync(`${ROOT}${file}`, 'utf8'), known).length, 0, `${file} leaks a name`);
  }
});

test('nor does the post, when it is on this machine', () => {
  for (const file of LOCAL_ONLY.filter((name) => existsSync(`${ROOT}${name}`))) {
    assert.deepEqual(leakedWords(readFileSync(`${ROOT}${file}`, 'utf8'), known).length, 0, `${file} leaks a name`);
  }
});
