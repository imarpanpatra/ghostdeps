// Runs the study. Every answer lands in data/runs.jsonl as soon as it exists,
// so a crash or a closed laptop loses one question at most, and a rerun skips
// whatever is already recorded.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extract } from './extract.js';
import { generate, modelInfo } from './ollama.js';
import { classifyAll } from './registry.js';

export const PATHS = {
  tasks: new URL('../data/tasks.json', import.meta.url),
  runs: new URL('../data/runs.jsonl', import.meta.url),
  registry: new URL('../data/registry.json', import.meta.url),
};

export const HAUNT_SEEDS = [11, 22, 33, 44, 55];
export const HAUNT_TEMPERATURE = 0.7;
const REGISTRY_NAME = { npm: 'npm', pip: 'PyPI' };

export function buildPrompt(eco, task) {
  const language = eco === 'npm' ? 'Node.js' : 'Python';
  return `I'm working in ${language}. I need to ${task}. Which package should I use? Show the install command and a short usage example.`;
}

export function buildMirrorPrompt(eco, name) {
  return `Is "${name}" a real package on ${REGISTRY_NAME[eco]}? Answer with only yes or no.`;
}

// The wording used by Spracklen et al. (USENIX Security 2025), so the second
// run of this test is comparable with theirs, and so one phrasing can't decide
// the answer on its own.
export function buildValidPrompt(eco, name) {
  return `Is "${name}" a valid ${eco === 'npm' ? 'npm' : 'Python'} package? Answer with only yes or no.`;
}

export function parseYesNo(text) {
  const match = text.match(/^\W*(yes|no)\b/i);
  return match ? match[1].toLowerCase() : 'unclear';
}

export function loadTasks() {
  const raw = readFileSync(PATHS.tasks);
  const tree = JSON.parse(raw);
  const tasks = [];
  for (const [eco, tiers] of Object.entries(tree)) {
    for (const [tier, list] of Object.entries(tiers)) {
      list.forEach((task, index) => tasks.push({ id: `${eco}/${tier}/${index}`, eco, tier, task }));
    }
  }
  return { tasks, hash: createHash('sha256').update(raw).digest('hex') };
}

export function loadRuns() {
  if (!existsSync(PATHS.runs)) return [];
  return readFileSync(PATHS.runs, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export function loadRegistry() {
  return new Map(existsSync(PATHS.registry) ? Object.entries(JSON.parse(readFileSync(PATHS.registry, 'utf8'))) : []);
}

function saveRegistry(cache) {
  writeFileSync(PATHS.registry, JSON.stringify(Object.fromEntries(cache), null, 2));
}

// Stops once a complete install command is on screen. An open code fence means
// the command may still be growing, so `npm install foo bar` is never cut in half.
export function stopAfterInstall(text) {
  const fences = (text.match(/```/g) ?? []).length;
  return fences % 2 === 0 && /\n\s*$/.test(text) && extract(text).length > 0;
}

const runKey = (run) => [run.round, run.model, run.id, run.seed, run.temperature].join('|');

async function ask(runs, seen, meta, base, prompt, options) {
  const key = runKey({ ...base, id: base.id });
  if (seen.has(key)) return;
  const started = Date.now();
  const { text } = await generate({ model: base.model, prompt, temperature: base.temperature, seed: base.seed, ...options });
  const run = { ...base, digest: meta.digest, prompt, text, ms: Date.now() - started, at: new Date().toISOString() };
  appendFileSync(PATHS.runs, `${JSON.stringify(run)}\n`);
  runs.push(run);
  seen.add(key);
  console.log(`${base.round} ${base.model} ${base.id} seed=${base.seed} ${run.ms}ms`);
}

async function sweep(model, tasks, runs, seen, meta) {
  for (const { id, eco, tier, task } of tasks) {
    await ask(runs, seen, meta, { round: 'sweep', model, id, eco, tier, task, seed: 1, temperature: 0 }, buildPrompt(eco, task), { shouldStop: stopAfterInstall });
  }
}

// Asks a slice of the sweep again, unchanged, to test the claim that a pinned
// open model gives everyone the same ghost.
async function determinism(model, tasks, runs, seen, meta) {
  for (const { id, eco, tier, task } of tasks.filter((_, index) => index % 4 === 0)) {
    await ask(runs, seen, meta, { round: 'determinism', model, id, eco, tier, task, seed: 1, temperature: 0 }, buildPrompt(eco, task), { shouldStop: stopAfterInstall });
  }
}

async function haunt(model, tasks, runs, seen, meta) {
  const registry = loadRegistry();
  const haunted = new Set(runs
    .filter((run) => run.round === 'sweep' && run.model === model)
    .filter((run) => extract(run.text).some(({ eco, name }) => registry.get(`${eco}:${name}`)?.state === 'ghost'))
    .map((run) => run.id));
  for (const { id, eco, tier, task } of tasks.filter((entry) => haunted.has(entry.id))) {
    for (const seed of HAUNT_SEEDS) {
      await ask(runs, seen, meta, { round: 'haunt', model, id, eco, tier, task, seed, temperature: HAUNT_TEMPERATURE }, buildPrompt(eco, task), { shouldStop: stopAfterInstall });
    }
  }
}

// "Do the ghosts know they're dead?" Puts the model's own niche answers back in
// front of it, ghosts and real packages alike. Only niche names are used: real
// packages from the everyday tasks are famous, and pairing obscure ghosts with
// `express` would measure fame instead of self-awareness.
async function mirror(model, runs, seen, meta, round = 'mirror', build = buildMirrorPrompt) {
  const registry = loadRegistry();
  const names = new Map();
  for (const run of runs.filter((entry) => entry.round === 'sweep' && entry.model === model && entry.tier === 'niche')) {
    for (const { eco, name } of extract(run.text)) names.set(`${eco}:${name}`, { eco, name });
  }
  const byState = (state) => [...names.entries()].filter(([key]) => registry.get(key)?.state === state).map(([, value]) => value);
  for (const [truth, list] of [['ghost', byState('ghost')], ['alive', byState('alive')]]) {
    for (const { eco, name } of list) {
      await ask(runs, seen, meta, { round, model, id: `${eco}:${name}`, eco, truth, seed: 1, temperature: 0 }, build(eco, name), { numPredict: 8 });
    }
  }
}

// Registry lookups run after generation, so the model half stays offline.
export async function resolveNames(runs = loadRuns()) {
  const cache = loadRegistry();
  const items = new Map();
  for (const run of runs) {
    if (run.round.startsWith('mirror')) continue;
    for (const { eco, name } of extract(run.text)) items.set(`${eco}:${name}`, { eco, name });
  }
  const retry = [...cache].filter(([, verdict]) => verdict.state === 'unknown').map(([key]) => key);
  for (const key of retry) cache.delete(key);
  await classifyAll([...items.values()], { cache });
  saveRegistry(cache);
  return cache;
}

export async function runRound(round, model) {
  const { tasks, hash } = loadTasks();
  const runs = loadRuns();
  const seen = new Set(runs.map(runKey));
  if (round === 'resolve') {
    const cache = await resolveNames(runs);
    console.log(`Resolved ${cache.size} names.`);
    return;
  }
  const meta = await modelInfo(model);
  console.log(`Model ${model} digest ${meta.digest.slice(0, 12)} tasks ${hash.slice(0, 12)}`);
  if (round === 'sweep') await sweep(model, tasks, runs, seen, meta);
  else if (round === 'determinism') await determinism(model, tasks, runs, seen, meta);
  else if (round === 'haunt') await haunt(model, tasks, runs, seen, meta);
  else if (round === 'mirror') await mirror(model, runs, seen, meta);
  else if (round === 'mirror-valid') await mirror(model, runs, seen, meta, 'mirror-valid', buildValidPrompt);
  else throw new Error(`Unknown round: ${round}`);
}
