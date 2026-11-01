import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract, parseBlocks } from '../src/extract.js';
import { gatherInputs, printable, readManifest } from '../src/scan.js';

// Bugs found by reviewing the rewritten parser. Each one was reproduced first.
const names = (text) => extract(text).map(({ eco, name }) => `${eco}:${name}`);
const bare = (text) => extract(text, { bare: true }).map(({ eco, name }) => `${eco}:${name}`);
const fence = (body) => `\`\`\`bash\n${body}\n\`\`\``;
const manifest = (file, text) => readManifest(file, text).names.map(({ eco, name }) => `${eco}:${name}`);

function reader(files) {
  return (file) => {
    if (!(file in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return Buffer.from(files[file]);
  };
}

test('a comment ending in a backtick, backslash or caret keeps the next command', () => {
  assert.deepEqual(names(fence('# Install `evil-pkg`\nnpm install evil-pkg')), ['npm:evil-pkg']);
  assert.deepEqual(names(fence('# see C:\\tools\\\nnpm install evil-two')), ['npm:evil-two']);
  assert.deepEqual(names(fence('// use x^\nnpm install evil-three')), ['npm:evil-three']);
});

test('a backtick or caret stuck to a word is not a continuation', () => {
  assert.deepEqual(names(fence('echo `date`\nnpm install evil-pkg')), ['npm:evil-pkg']);
  assert.deepEqual(names(fence('echo x^\nnpm install evil-two')), ['npm:evil-two']);
});

test('continuations work outside fences too', () => {
  assert.deepEqual(bare('npm install \\\n  evil-a\n'), ['npm:evil-a']);
  assert.deepEqual(names('$ npm install \\\n  evil-b\n'), ['npm:evil-b']);
  assert.deepEqual(names('    npm install \\\n      evil-c\n'), ['npm:evil-c']);
  assert.deepEqual(names(fence('npm install one-a \\')), ['npm:one-a']);
});

test('a commented command may keep its launcher', () => {
  assert.deepEqual(names(fence('# python -m pip install evil-a')), ['pip:evil-a']);
  assert.deepEqual(names(fence('// uv pip install evil-b')), ['pip:evil-b']);
  assert.deepEqual(names(fence('# sudo pip install evil-c')), ['pip:evil-c']);
  assert.deepEqual(names(fence('# $ pip install evil-d')), ['pip:evil-d']);
});

test('a sentence around a command keeps the command', () => {
  assert.deepEqual(bare('Run npm install evil-pkg to add it to your project.'), ['npm:evil-pkg']);
  assert.deepEqual(bare('Use pip install evil-two and then import it.'), ['pip:evil-two']);
  assert.deepEqual(bare('Try npm install evil-three in your project folder.'), ['npm:evil-three']);
});

test('plain-text punctuation does not hide a command', () => {
  assert.deepEqual(bare('**npm install evil-a**'), ['npm:evil-a']);
  assert.deepEqual(bare('[pip install evil-b]'), ['pip:evil-b']);
  assert.deepEqual(bare('{npm install evil-c}'), ['npm:evil-c']);
  assert.deepEqual(bare('Have you tried pip install evil-d?'), ['pip:evil-d']);
  assert.deepEqual(bare('npm install evil-e!'), ['npm:evil-e']);
  assert.deepEqual(bare('pip install evil-f - it works'), ['pip:evil-f']);
});

test('a real name ending in an underscore keeps it', () => {
  assert.deepEqual(names(fence('npm install lodash_')), ['npm:lodash_']);
});

test('a redirect in the middle does not hide what follows it', () => {
  assert.deepEqual(names(fence('npm install good 2>/dev/null evil-pkg')), ['npm:good', 'npm:evil-pkg']);
  assert.deepEqual(names(fence('npm install good > log.txt evil-pkg')), ['npm:good', 'npm:evil-pkg']);
});

test('a real command with trailing English is still a real command', () => {
  assert.deepEqual(names(fence('npm install lodash && npm install evil-pkg to the')), ['npm:lodash', 'npm:evil-pkg', 'npm:to', 'npm:the']);
});

test('runners take the package from the flag in every spelling', () => {
  assert.deepEqual(names(fence('npx --package evil-a lodash')), ['npm:evil-a']);
  assert.deepEqual(names(fence('npx --package=evil-b lodash')), ['npm:evil-b']);
  assert.deepEqual(names(fence('uvx --from evil-c cmd')), ['pip:evil-c']);
  assert.deepEqual(names(fence('uvx --from=evil-d cmd')), ['pip:evil-d']);
  assert.deepEqual(names(fence('npx --package evil-e --package evil-f cmd')), ['npm:evil-e', 'npm:evil-f']);
});

test('the other runners are read', () => {
  assert.deepEqual(names(fence('npm exec evil-a\nnpm x evil-b\npnpx evil-c\nbun x evil-d\nuv tool run evil-e')), ['npm:evil-a', 'npm:evil-b', 'npm:evil-c', 'npm:evil-d', 'pip:evil-e']);
});

test('a flag with its value missing does not crash', () => {
  assert.deepEqual(names('Use `npx -p` to choose.'), []);
  assert.deepEqual(names(fence('npx --package')), []);
  assert.deepEqual(names(fence('uvx --from')), []);
});

test('sentences about installing are not commands', () => {
  for (const line of ['Then pip install them.', 'pip install worked.', 'Run npm install manually.', 'How to pip install offline', 'pip install without sudo', 'npm install hangs forever']) {
    assert.deepEqual(bare(line), [], line);
  }
});

test('title case and the pronoun I are not installers in plain text', () => {
  assert.deepEqual(bare('NPM Install Instructions'), []);
  assert.deepEqual(bare('Pip Install Guide'), []);
  assert.deepEqual(bare('With npm I usually pin versions.'), []);
  assert.deepEqual(bare('I think npx runs slowly'), []);
  assert.deepEqual(bare('NPM Install Walkthrough'), []);
  assert.deepEqual(bare('With npm I typically pin versions.'), []);
  assert.deepEqual(names(fence('# NPM Install Instructions')), []);
});

test('flags are read per Python tool too', () => {
  assert.deepEqual(names(fence('pipx install -f evil-a')), ['pip:evil-a']);
  assert.deepEqual(names(fence('uv add -p 3.12 evil-b')), ['pip:evil-b']);
  assert.deepEqual(names(fence('pdm add -dG test evil-c')), ['pip:evil-c']);
  assert.deepEqual(names(fence('npm install --omit dev --location global evil-d')), ['npm:evil-d']);
  assert.deepEqual(names(fence('yarn add --network-timeout 1000 evil-e')), ['npm:evil-e']);
  assert.deepEqual(names(fence('pip install --use-feature x --exists-action w evil-f')), ['pip:evil-f']);
});

test('fences close the way markdown says they do', () => {
  assert.deepEqual(parseBlocks('````\na\n```\nb\n````').blocks, [{ info: '', body: 'a\n```\nb' }]);
  assert.deepEqual(parseBlocks('~~~\na\n```\nb\n~~~').blocks, [{ info: '', body: 'a\n```\nb' }]);
  assert.deepEqual(parseBlocks('```\na\n``` trailing\nb\n```').blocks, [{ info: '', body: 'a\n``` trailing\nb' }]);
});

test('crafted lines finish quickly', () => {
  const started = Date.now();
  names(fence(`pnpm ${'-F x '.repeat(5000)}`));
  names(fence(`pnpm ${'-F '.repeat(60)}`));
  manifest('requirements.txt', `x${'==a'.repeat(5000)}\n`);
  assert.ok(Date.now() - started < 1000);
});

test('a chat answer is not sniffed as a requirements file', () => {
  assert.deepEqual(manifest('answer.md', 'Options\n- pip install evil-pkg\n'), ['pip:evil-pkg']);
  assert.deepEqual(manifest('answer.md', 'Installation\nRun: npm install evil-pkg\n'), ['npm:evil-pkg']);
  assert.deepEqual(manifest(undefined, 'Options\n- pip install evil-pkg\n'), ['pip:evil-pkg']);
});

test('a bullet is not a pip option, so a list is not a requirements file', () => {
  assert.equal(readManifest(undefined, 'Notes\n- use the old one\n').kind, 'text');
});

test('a command on an option-shaped line still stops the sniffing', () => {
  assert.deepEqual(manifest(undefined, 'Setup\n-y pip install evil-pkg\n'), ['pip:evil-pkg']);
});

test('a file name has to actually say requirements', () => {
  for (const file of ['request.txt', 'prerequisites.txt', 'pull-request-notes.txt', 'frequently-asked.txt']) {
    assert.deepEqual(manifest(file, 'Sure!\nnpm install evil-pkg\nThen restart.\n'), ['npm:evil-pkg'], file);
  }
});

test('the names a requirements file can go by', () => {
  for (const file of ['requirements.txt', 'requirements-dev.txt', 'dev-requirements.txt', 'reqs.txt', 'req.txt', 'requirements.in', 'test_requirements.txt', 'requirements/dev.txt', 'requirements\\dev.txt']) {
    assert.deepEqual(manifest(file, 'flask\nnot a real line\n'), ['pip:flask', 'pip:not'], file);
  }
});

test('attached and spelled-out includes are both includes', () => {
  assert.deepEqual(readManifest('requirements.txt', '-rbase.txt\n-r two.txt\n--requirement three.txt\n--requirement=four.txt\n').includes, ['base.txt', 'two.txt', 'three.txt', 'four.txt']);
});

test('a hashed requirement is a requirement', () => {
  const text = 'flask==3.0 \\\n    --hash=sha256:abc \\\n    --hash=sha256:def\n';
  assert.deepEqual(manifest(undefined, text), ['pip:flask']);
});

test('a comment line in a requirements file never continues', () => {
  assert.deepEqual(manifest('requirements.txt', '# old pin \\\nevil-pkg==1.0\n'), ['pip:evil-pkg']);
});

test('requirements in an answer are read with any pin or a label', () => {
  assert.deepEqual(manifest('answer.md', 'Use:\n```\n# requirements.txt\nevil-a\n```\n'), ['pip:evil-a']);
  assert.deepEqual(manifest('answer.md', 'Use:\n```\nevil-b>=1.0\n```\n'), ['pip:evil-b']);
  assert.deepEqual(manifest('answer.md', 'Use:\n```text\nevil-c~=1.0\n```\n'), ['pip:evil-c']);
});

test('a spaced comparison in a code block is not a requirements block', () => {
  assert.deepEqual(manifest('answer.md', 'Check:\n```\na == b\n```\n'), []);
});

test('a manifest fragment in an answer is read', () => {
  assert.deepEqual(manifest('answer.md', 'Add:\n```json\n"dependencies": {\n  "evil-a": "^1.0.0", // the parser\n  "evil-b": "1.0.0",\n}\n```\n'), ['npm:evil-a', 'npm:evil-b']);
  assert.deepEqual(manifest('answer.md', 'Add:\n```json\n{ "dependencies": { "evil-c": "1", "x": "file:../x" }, ... }\n```\n'), ['npm:evil-c']);
});

test('a file that yields nothing is a problem, even next to a good one', () => {
  const read = reader({ 'package.json': '{"dependencies":{"a":"1"}}', 'pyproject.toml': '[project]\ndependencies = ["evil-pkg"]\n' });
  const { names: found, problems } = gatherInputs(['package.json', 'pyproject.toml'], read);
  assert.equal(found.length, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /pyproject\.toml: no package names/);
});

test('an included file is a requirements file, whatever it looks like', () => {
  const dir = process.cwd();
  const base = `${dir}${dir.includes('\\') ? '\\' : '/'}hashed.txt`;
  const read = reader({ 'requirements.txt': 'flask\n-r hashed.txt\n', [base]: 'evil-pkg==1.0 --hash=sha256:abc\nnot a clean line\n' });
  const { names: found, problems } = gatherInputs(['requirements.txt'], read);
  assert.deepEqual(found.map(({ name }) => name), ['flask', 'evil-pkg', 'not']);
  assert.deepEqual(problems, []);
});

test('an include read from stdin is reported, and what came before it is kept', () => {
  const { names: found, problems } = gatherInputs([], reader({ null: 'flask\n-r base.txt\n' }));
  assert.deepEqual(found.map(({ name }) => name), ['flask']);
  assert.match(problems[0], /stdin.*can't be followed/);
});

test('escape codes cannot reach the terminal', () => {
  assert.equal(printable('\u001b[2K\rGOOD'), '?[2K?GOOD');
  assert.equal(printable('\u009b31m'), '?31m');
  const { problems } = gatherInputs(['\u001b[2Kx.json'], reader({}));
  assert.doesNotMatch(problems[0], /\u001b/);
});
