import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract } from '../src/extract.js';

// Forms of a real command that the final review found the parser missing.
const names = (text) => extract(text).map(({ eco, name }) => `${eco}:${name}`);
const bare = (text) => extract(text, { bare: true }).map(({ eco, name }) => `${eco}:${name}`);
const fence = (body) => `\`\`\`bash\n${body}\n\`\`\``;

test('a value flag before the verb does not hide the command', () => {
  assert.deepEqual(names(fence('npm --prefix client install evil-a')), ['npm:evil-a']);
  assert.deepEqual(names(fence('npm -w api install evil-b')), ['npm:evil-b']);
  assert.deepEqual(names(fence('npm --workspace api install evil-c')), ['npm:evil-c']);
  assert.deepEqual(names(fence('yarn --cwd client add evil-d')), ['npm:evil-d']);
});

test('--with adds to the tool a runner fetches', () => {
  assert.deepEqual(names(fence('uvx --with flask evil-a')), ['pip:flask', 'pip:evil-a']);
  assert.deepEqual(names(fence('uvx --with=flask evil-b')), ['pip:flask', 'pip:evil-b']);
  assert.deepEqual(names(fence('uv tool run --with flask evil-c')), ['pip:flask', 'pip:evil-c']);
});

test('uv run only fetches what --with names', () => {
  assert.deepEqual(names(fence('uv run -p 3.12 main.py')), []);
  assert.deepEqual(names(fence('uv run --package web app')), []);
});

test('Makefile prefixes are not part of the command', () => {
  assert.deepEqual(names(fence('@pip install evil-a\n@npm install evil-b\n-pip install evil-c')), ['pip:evil-a', 'npm:evil-b', 'pip:evil-c']);
});

test('list-form commands are commands', () => {
  assert.deepEqual(names(fence('subprocess.run(["pip", "install", "evil-a"])')), ['pip:evil-a']);
  assert.deepEqual(names(fence(`subprocess.check_call([sys.executable, "-m", "pip", "install", "evil-b"])`)), ['pip:evil-b']);
  assert.deepEqual(names(fence(`RUN ['pip', 'install', 'evil-c']`)), ['pip:evil-c']);
});

test('a runner name that is an argument stays an argument', () => {
  assert.deepEqual(names(fence('pip install uvx flask evil-a')), ['pip:uvx', 'pip:flask', 'pip:evil-a']);
  assert.deepEqual(names(fence('npm install -g npx')), ['npm:npx']);
  assert.deepEqual(names(fence('pip install uvx')), ['pip:uvx']);
  assert.deepEqual(names(fence('npm i @a/npx evil-b evil-c')), ['npm:@a/npx', 'npm:evil-b', 'npm:evil-c']);
  assert.deepEqual(names(fence('pip install --index-url https://x.test/uvx flask evil-d')), ['pip:flask', 'pip:evil-d']);
});

test('a runner after a new sentence is a new command', () => {
  assert.deepEqual(bare('Run npm install evil-a and npx evil-b'), ['npm:evil-a', 'npm:evil-b']);
  assert.deepEqual(bare('Use npm install evil-c. npx evil-d'), ['npm:evil-c', 'npm:evil-d']);
});

test('in the census, a comment stops at its first prose word for good', () => {
  assert.deepEqual(names(fence('# pip install redis and then run the server')), ['pip:redis']);
  assert.deepEqual(names(fence('# pip install flask then restart')), ['pip:flask']);
});
