import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract, normalize } from '../src/extract.js';
import { stopAfterInstall } from '../src/census.js';

const names = (text) => extract(text).map(({ eco, name }) => `${eco}:${name}`);
const fence = (body) => `\`\`\`bash\n${body}\n\`\`\``;

test('reads a plain install from a fenced block', () => {
  assert.deepEqual(names(fence('npm install fixture-pkg')), ['npm:fixture-pkg']);
});

test('prose is never an install command', () => {
  assert.deepEqual(names('Run npm install to fetch the dependencies, then pip install the rest.'), []);
});

test('reads every package on a line and skips flags', () => {
  assert.deepEqual(names(fence('npm i -D --save-exact alpha beta@1.2.3')), ['npm:alpha', 'npm:beta']);
});

test('keeps scopes and strips scoped versions', () => {
  assert.deepEqual(names(fence('yarn add @scope/thing@^2.0.0')), ['npm:@scope/thing']);
});

test('an owner/repo install is GitHub, not a registry name', () => {
  assert.deepEqual(names(fence('npm install someone/some-repo')), []);
});

test('covers every installer the models use', () => {
  const text = fence('pnpm add a1\nbun add b1\nyarn global add c1\npip3 install d1\npython -m pip install e1\nuv pip install f1');
  assert.deepEqual(names(text), ['npm:a1', 'npm:b1', 'npm:c1', 'pip:d1', 'pip:e1', 'pip:f1']);
});

test('strips pip extras, pins and quotes', () => {
  assert.deepEqual(names(fence(`pip install "uvicorn[standard]>=0.30" 'pydantic==2.8.0' httpx~=0.27`)), ['pip:uvicorn', 'pip:pydantic', 'pip:httpx']);
});

test('pip names follow PEP 503, so spellings of one project are one project', () => {
  assert.deepEqual(names(fence('pip install Ruamel.YAML ruamel_yaml')), ['pip:ruamel-yaml']);
  assert.equal(normalize('npm', 'JSONStream'), 'JSONStream');
});

test('a requirements file is not a package', () => {
  assert.deepEqual(names(fence('pip install -r requirements.txt')), []);
  assert.deepEqual(names(fence('pip install -e .')), []);
  assert.deepEqual(names(fence('pip install -r deps.in')), []);
  assert.deepEqual(names(fence('pip install -e libs')), []);
});

test('a flag value is not a package', () => {
  assert.deepEqual(names(fence('pip install --index-url https://x.test/simple real-one')), ['pip:real-one']);
  assert.deepEqual(names(fence('npm install --registry https://x.test real-two')), ['npm:real-two']);
  assert.deepEqual(names(fence('pip install -t vendor real-three')), ['pip:real-three']);
  assert.deepEqual(names(fence('npm install --tag beta real-four')), ['npm:real-four']);
});

test('urls, paths and archives are not registry names', () => {
  assert.deepEqual(names(fence('pip install git+https://github.com/a/b.git ./local dist/x-1.0.whl https://x.test/y.tar.gz')), []);
  assert.deepEqual(names(fence('npm install https://x.test/z.tgz file:../local git+ssh://x.test/y.git')), []);
  assert.deepEqual(names(fence('pip install thing-1.0.tar.gz other-2.0-py3-none-any.whl')), []);
  assert.deepEqual(names(fence('npm install thing-1.0.0.tgz')), []);
});

test('placeholders are not ghosts', () => {
  assert.deepEqual(names(fence('npm install package-name\npip install your-package <package>')), []);
});

test('stops at shell separators and trailing comments', () => {
  assert.deepEqual(names(fence('npm install one && node index.js')), ['npm:one']);
  assert.deepEqual(names(fence('pip install two # then restart')), ['pip:two']);
  assert.deepEqual(names(fence('pip install three; python main.py')), ['pip:three']);
});

test('a comment that is a command counts, as models write them', () => {
  assert.deepEqual(names(fence('# pip install redis')), ['pip:redis']);
  assert.deepEqual(names(fence('// npm install cors')), ['npm:cors']);
  assert.deepEqual(names(fence('# pip install psycopg2-binary  # no compiler needed')), ['pip:psycopg2-binary']);
});

test('a comment that merely mentions a command is a sentence', () => {
  assert.deepEqual(names(fence('# run npm install first')), []);
  assert.deepEqual(names(fence('// then use pip install on the server')), []);
  assert.deepEqual(names(fence('# Remember to pip install everything')), []);
});

test('reads inline code and shell prompts', () => {
  assert.deepEqual(names('Install it with `npm install inline-one`.'), ['npm:inline-one']);
  assert.deepEqual(names('Then:\n\n$ pip install prompt-two\n'), ['pip:prompt-two']);
});

test('trailing punctuation inside a span does not change the name', () => {
  assert.deepEqual(names('`pip install trailing-one.`'), ['pip:trailing-one']);
});

test('a code example that merely imports something is not an install', () => {
  assert.deepEqual(names(fence(`const x = require('only-imported');`)), []);
});

test('does not stop until the install is complete', () => {
  assert.equal(stopAfterInstall('Use this:\n```bash\nnpm install half'), false);
  assert.equal(stopAfterInstall('Use this:\n```bash\nnpm install first\n'), false);
  assert.equal(stopAfterInstall('Use this:\n```bash\nnpm install done\n```\n'), true);
  assert.equal(stopAfterInstall('Some prose with no command at all.\n'), false);
  assert.equal(stopAfterInstall('```bash\nnpm install\n```\n'), false);
});
