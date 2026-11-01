import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract } from '../src/extract.js';

const names = (text) => extract(text).map(({ eco, name }) => `${eco}:${name}`);
const bare = (text) => extract(text, { bare: true }).map(({ eco, name }) => `${eco}:${name}`);
const fence = (body) => `\`\`\`bash\n${body}\n\`\`\``;

test('reads every install on a line', () => {
  assert.deepEqual(names(fence('npm install one-a && npm install two-a')), ['npm:one-a', 'npm:two-a']);
  assert.deepEqual(names(fence('npm install && npm install two-b')), ['npm:two-b']);
  assert.deepEqual(names(fence('pip install one-c; pip install two-c')), ['pip:one-c', 'pip:two-c']);
});

test('follows line continuations in all three shells', () => {
  assert.deepEqual(names(fence('npm install one-a \\\n  two-a \\\n  three-a')), ['npm:one-a', 'npm:two-a', 'npm:three-a']);
  assert.deepEqual(names(fence('npm install `\n  two-b')), ['npm:two-b']);
  assert.deepEqual(names(fence('npm install ^\n  two-c')), ['npm:two-c']);
});

test('an alias installs its target, so the target is what gets checked', () => {
  assert.deepEqual(names(fence('npm install nice@npm:real-target')), ['npm:real-target']);
  assert.deepEqual(names(fence('npm install @me/nice@npm:@them/real@1.0.0')), ['npm:@them/real']);
});

test('my- and your- are not a free namespace', () => {
  assert.deepEqual(names(fence('npm install my-logger-kit')), ['npm:my-logger-kit']);
  assert.deepEqual(names(fence('pip install your_gpt_client')), ['pip:your-gpt-client']);
  assert.deepEqual(names(fence('npm install @your-org/evil')), ['npm:@your-org/evil']);
  assert.deepEqual(names(fence('npm install foo bar')), ['npm:foo', 'npm:bar']);
});

test('real names that end like a file are still names', () => {
  assert.deepEqual(names(fence('npm install lodash.zip evil.txt evil2.toml')), ['npm:lodash.zip', 'npm:evil.txt', 'npm:evil2.toml']);
});

test('flags are read per tool', () => {
  assert.deepEqual(names(fence('npm install -f one-a')), ['npm:one-a']);
  assert.deepEqual(names(fence('pnpm add -r two-a')), ['npm:two-a']);
  assert.deepEqual(names(fence('pnpm add -w three-a')), ['npm:three-a']);
  assert.deepEqual(names(fence('npm install -w api four-a')), ['npm:four-a']);
  assert.deepEqual(names(fence('pip install -r r.txt five-a')), ['pip:five-a']);
  assert.deepEqual(names(fence('pip install -e . six-a')), ['pip:six-a']);
});

test('a wildcard or variable pin keeps the name', () => {
  assert.deepEqual(names(fence('pip install "evil-a==1.*" evil-b==$VER')), ['pip:evil-a', 'pip:evil-b']);
  assert.deepEqual(names(fence('npm install evil-c@* evil-d@$VER')), ['npm:evil-c', 'npm:evil-d']);
});

test('a whole variable is not a name', () => {
  assert.deepEqual(names(fence('npm install $PKG ${OTHER}\npip install $PKG')), []);
});

test('covers the installers people actually use', () => {
  const text = fence([
    '!pip install a-one', '%pip install a-two', './venv/bin/pip install a-three', '.venv\\Scripts\\pip install a-four',
    'pip3.11 install a-five', 'pip -q install a-six', 'pipx install a-seven', 'pipenv install a-eight',
    'poetry add a-nine', 'uv add a-ten', 'pdm add a-eleven', 'npm -g install b-one', 'pnpm --filter web add b-two',
    'yarn workspace web add b-three', 'bun i b-four', 'NPM INSTALL b-five',
  ].join('\n'));
  assert.deepEqual(names(text), [
    'pip:a-one', 'pip:a-two', 'pip:a-three', 'pip:a-four', 'pip:a-five', 'pip:a-six', 'pip:a-seven', 'pip:a-eight',
    'pip:a-nine', 'pip:a-ten', 'pip:a-eleven', 'npm:b-one', 'npm:b-two', 'npm:b-three', 'npm:b-four', 'npm:b-five',
  ]);
});

test('a runner fetches one package, the rest are its arguments', () => {
  assert.deepEqual(names(fence('npx -y runner-one --flag arg')), ['npm:runner-one']);
  assert.deepEqual(names(fence('bunx runner-two arg')), ['npm:runner-two']);
  assert.deepEqual(names(fence('pnpm dlx runner-three arg')), ['npm:runner-three']);
  assert.deepEqual(names(fence('uvx runner-four arg')), ['pip:runner-four']);
  assert.deepEqual(names(fence('npx -p runner-five cmd arg')), ['npm:runner-five']);
});

test('installs wrapped in another command are still installs', () => {
  assert.deepEqual(names(fence('bash -c "pip install wrapped-one"')), ['pip:wrapped-one']);
  assert.deepEqual(names(fence('os.system("pip install wrapped-two")')), ['pip:wrapped-two']);
});

test('reads fence styles other than three backticks', () => {
  assert.deepEqual(names('~~~bash\npip install tilde-one\n~~~'), ['pip:tilde-one']);
  assert.deepEqual(names('````\npip install four-ticks\n````'), ['pip:four-ticks']);
  assert.deepEqual(names('Install it:\n\n    pip install indent-one\n'), ['pip:indent-one']);
});

test('a one-line triple backtick is code, and does not swallow the next fence', () => {
  assert.deepEqual(names('Run ```pip install fence-one``` now.'), ['pip:fence-one']);
  assert.deepEqual(names('```pip install fence-two```\n'), ['pip:fence-two']);
  assert.deepEqual(names('```x```\n\n```bash\nnpm install after-it\n```'), ['npm:after-it']);
});

test('Windows and virtualenv prompts are prompts', () => {
  assert.deepEqual(names('PS C:\\app> npm install ps-one\n'), ['npm:ps-one']);
  assert.deepEqual(names('C:\\app> npm install cmd-one\n'), ['npm:cmd-one']);
  assert.deepEqual(names('(venv) $ pip install venv-one\n'), ['pip:venv-one']);
});

test('the census reads code only, check also reads plain text', () => {
  const copied = 'bash\nCopy code\nnpm install bare-one\n';
  assert.deepEqual(names(copied), []);
  assert.deepEqual(bare(copied), ['npm:bare-one']);
  assert.deepEqual(bare('You can add it with npm install bare-two.'), ['npm:bare-two']);
  assert.deepEqual(bare('<pre><code>npm install html-one &amp;&amp; npm install html-two</code></pre>'), ['npm:html-one', 'npm:html-two']);
});

test('plain text still has to read like a command', () => {
  assert.deepEqual(bare('Run npm install to fetch the dependencies, then pip install the rest.'), []);
  assert.deepEqual(bare('pip install the rest'), []);
  assert.deepEqual(bare('npm install failed with errors'), []);
  assert.deepEqual(bare('Next, run npm install to begin.'), []);
});

test('blockquoted prose is prose, a blockquoted command is a command', () => {
  assert.deepEqual(names('> Run npm install to begin\n'), []);
  assert.deepEqual(bare('> Run npm install to begin\n'), []);
  assert.deepEqual(names('> npm install quoted-one\n'), ['npm:quoted-one']);
});

test('a sentence in a code block is not a command', () => {
  assert.deepEqual(names(fence('npm install failed with errors')), []);
});

test('a real command survives one word that happens to be English', () => {
  assert.deepEqual(names(fence('npm install chalk first')), ['npm:chalk', 'npm:first']);
});

test('redirects and flag values are not packages', () => {
  assert.deepEqual(names(fence('pip install wheel 2>&1')), ['pip:wheel']);
  assert.deepEqual(names(fence('pip install -q wheel 2>/dev/null')), ['pip:wheel']);
  assert.deepEqual(names(fence('pip install wheel > /dev/null 2>&1')), ['pip:wheel']);
  assert.deepEqual(names(fence('pip install --timeout 60 wheel')), ['pip:wheel']);
  assert.deepEqual(names(fence('pip install wheel --python-version 3.11')), ['pip:wheel']);
  assert.deepEqual(names(fence('pnpm add lodash --filter web-app')), ['npm:lodash']);
  assert.deepEqual(names(fence('npm install lodash --workspace api')), ['npm:lodash']);
  assert.deepEqual(names(fence('npm install lodash --loglevel error')), ['npm:lodash']);
});

test('a quoted specifier is one argument', () => {
  assert.deepEqual(names(fence('pip install "wheel >= 1.0" other-one')), ['pip:wheel', 'pip:other-one']);
});

test('a comment with no space still ends the command', () => {
  assert.deepEqual(names(fence('pip install wheel #then the rest')), ['pip:wheel']);
});

test('placeholders are skipped by exact name only', () => {
  assert.deepEqual(names(fence('npm install @your-org/your-package some-package @scope/package')), []);
});

test('a token too long to be a name is ignored quickly', () => {
  const started = Date.now();
  assert.deepEqual(names(fence(`pip install ${'.'.repeat(1_000_000)}x`)), []);
  assert.ok(Date.now() - started < 1000);
});
