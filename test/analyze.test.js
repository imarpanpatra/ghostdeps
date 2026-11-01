import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize } from '../src/analyze.js';

const install = (...names) => `\`\`\`bash\nnpm install ${names.join(' ')}\n\`\`\`\n`;
const base = { model: 'gemma3:4b', eco: 'npm', tier: 'niche', digest: 'x', seed: 1, temperature: 0 };
const sweep = (id, text) => ({ ...base, round: 'sweep', id, text });
const again = (id, text) => ({ ...base, round: 'determinism', id, text });
const determinism = (runs, registry = new Map()) => summarize(runs, registry).summary.models['gemma3:4b'].determinism;

test('two answers with no package do not count as naming the same one', () => {
  const result = determinism([sweep('a', 'use the stdlib'), again('a', 'use the stdlib'), sweep('b', install('one')), again('b', install('one'))]);
  assert.equal(result.rerun, 2);
  assert.equal(result.comparable, 1);
  assert.equal(result.sameNames, 1);
});

test('the same names in a different order are the same names', () => {
  assert.equal(determinism([sweep('a', install('one', 'two')), again('a', install('two', 'one'))]).sameNames, 1);
});

test('a different name is not the same name', () => {
  assert.equal(determinism([sweep('a', install('one')), again('a', install('two'))]).sameNames, 0);
});

test('an answer that names nothing the second time counts against', () => {
  const result = determinism([sweep('a', install('one')), again('a', 'nothing')]);
  assert.equal(result.comparable, 1);
  assert.equal(result.sameNames, 0);
});

test('tracks whether the ghosts specifically came back', () => {
  const registry = new Map([['npm:gone', { state: 'ghost' }], ['npm:stays', { state: 'ghost' }], ['npm:real', { state: 'alive' }]]);
  const runs = [sweep('a', install('gone')), again('a', install('other')), sweep('b', install('stays')), again('b', install('stays')), sweep('c', install('real')), again('c', install('real'))];
  const result = determinism(runs, registry);
  assert.equal(result.ghostsTracked, 2);
  assert.equal(result.ghostsRepeated, 1);
});

test('a repeat with no sweep answer is skipped, not a crash', () => {
  assert.equal(determinism([sweep('a', install('one')), again('b', install('one'))]).rerun, 0);
});
