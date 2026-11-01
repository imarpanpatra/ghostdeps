import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract } from '../src/extract.js';
import { gatherInputs, readManifest } from '../src/scan.js';

// Bugs the third review found in how plain text and comments are read.
const names = (text) => extract(text).map(({ eco, name }) => `${eco}:${name}`);
const bare = (text) => extract(text, { bare: true }).map(({ eco, name }) => `${eco}:${name}`);
const fence = (body) => `\`\`\`bash\n${body}\n\`\`\``;
const manifest = (file, text) => readManifest(file, text).names.map(({ eco, name }) => `${eco}:${name}`);

test('every command in a sentence is read', () => {
  assert.deepEqual(bare('Install with pip install flask, then pip install evil-pkg.'), ['pip:flask', 'pip:evil-pkg']);
  assert.deepEqual(bare('Use pip install flask. Then pip install evil-pkg.'), ['pip:flask', 'pip:evil-pkg']);
  assert.deepEqual(bare('Run npm install lodash and npm install evil-pkg'), ['npm:lodash', 'npm:evil-pkg']);
});

test('a list in a sentence is read to its end', () => {
  assert.deepEqual(bare('Run pip install numpy, pandas and evil-pkg to get started.'), ['pip:numpy', 'pip:pandas', 'pip:evil-pkg']);
  assert.deepEqual(bare('You can pip install flask or evil-pkg for this.'), ['pip:flask', 'pip:evil-pkg']);
});

test('a requirements file with an install command in a comment is still one', () => {
  assert.deepEqual(manifest(undefined, '# pip install --upgrade pip\nflask==3.0\nevil-pkg==1.0\n'), ['pip:flask', 'pip:evil-pkg']);
  assert.deepEqual(manifest('deps.txt', 'torch==2.0  # pip install torch --index-url x\nevil-pkg==1.0\n'), ['pip:torch', 'pip:evil-pkg']);
});

test('a pinned requirements block is read whatever its label', () => {
  for (const label of ['bash', 'ini', 'python']) {
    assert.deepEqual(manifest('answer.md', `Use:\n\`\`\`${label}\nevil-pkg==1.0\n\`\`\`\n`), ['pip:evil-pkg'], label);
  }
});

test('real commands survive the case rule', () => {
  assert.deepEqual(bare('NPM INSTALL evil-a'), ['npm:evil-a']);
  assert.deepEqual(bare('Pip install evil-b'), ['pip:evil-b']);
  assert.deepEqual(bare('Npm install evil-c'), ['npm:evil-c']);
  assert.deepEqual(bare('yarn workspace MyApp add evil-d'), ['npm:evil-d']);
  assert.deepEqual(bare('pnpm --filter MyApp add evil-e'), ['npm:evil-e']);
});

test('a name with digits in it is not the word they hide', () => {
  assert.deepEqual(bare('Run npm install express i18n evil-pkg'), ['npm:express', 'npm:i18n', 'npm:evil-pkg']);
  assert.deepEqual(bare('Run pip install 2to3 evil-two'), ['pip:2to3', 'pip:evil-two']);
  assert.deepEqual(bare('npm install once evil-three'), ['npm:once', 'npm:evil-three']);
});

test('check reads comments with a lead-in, the census does not', () => {
  for (const comment of ['# Install with: pip install evil-pkg', '// Run: pip install evil-pkg', '# Requires pip install evil-pkg']) {
    assert.deepEqual(bare(fence(comment)), ['pip:evil-pkg'], comment);
    assert.deepEqual(names(fence(comment)), [], comment);
  }
});

test('a heading with a command in it is read', () => {
  assert.deepEqual(bare('# Then run: npm install evil-pkg\n'), ['npm:evil-pkg']);
});

test('a comment that only mentions installing stays a sentence in check too', () => {
  assert.deepEqual(bare(fence('# Remember to pip install everything')), []);
  assert.deepEqual(bare(fence('# run npm install first')), []);
});

test('scaffolders fetch create-<name>', () => {
  assert.deepEqual(names(fence('npm create evil-a@latest my-app')), ['npm:create-evil-a']);
  assert.deepEqual(names(fence('npm init evil-b my-app')), ['npm:create-evil-b']);
  assert.deepEqual(names(fence('yarn create evil-c')), ['npm:create-evil-c']);
  assert.deepEqual(names(fence('pnpm create evil-d')), ['npm:create-evil-d']);
  assert.deepEqual(names(fence('bun create evil-e')), ['npm:create-evil-e']);
  assert.deepEqual(names(fence('npm create @acme/thing')), ['npm:@acme/create-thing']);
});

test('npm init on its own is not a package', () => {
  assert.deepEqual(names(fence('npm init\nnpm init -y')), []);
});

test('uv run installs what --with names, not its script', () => {
  assert.deepEqual(names(fence('uv run --with evil-pkg main.py')), ['pip:evil-pkg']);
  assert.deepEqual(names(fence('uv run --with=evil-two main.py')), ['pip:evil-two']);
  assert.deepEqual(names(fence('uv run main.py')), []);
});

test('uv --extra takes a value', () => {
  assert.deepEqual(names(fence('uv add --extra foo evil-pkg')), ['pip:evil-pkg']);
});

test('common sentences about an install finishing are not packages', () => {
  assert.deepEqual(bare('Once npm install finishes, start the server.'), []);
  assert.deepEqual(bare('After npm install completes, restart.'), []);
  assert.deepEqual(bare('pip install uses a cache.'), []);
});

test('a result read from prose says so, a manifest does not', () => {
  const read = (file) => Buffer.from(file === 'answer.md' ? 'Run npm install evil-pkg\n' : 'flask==3.0\n');
  assert.equal(gatherInputs(['answer.md'], read).prose, true);
  assert.equal(gatherInputs(['requirements.txt'], read).prose, false);
});
