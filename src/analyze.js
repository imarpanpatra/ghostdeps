// Turns data/runs.jsonl and data/registry.json into the numbers the post quotes.
// data/summary.json and data/ghosts.json are the only outputs that get published,
// and neither contains a full ghost name.

import { writeFileSync } from 'node:fs';
import { HAUNT_SEEDS, loadRegistry, loadRuns, parseYesNo } from './census.js';
import { extract } from './extract.js';
import { GHOSTS_PATH, hashName, redact } from './ghosts.js';
import { STATES } from './registry.js';

const SUMMARY_PATH = new URL('../data/summary.json', import.meta.url);
const pct = (part, whole) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);

function tally(runs, registry) {
  const states = Object.fromEntries(STATES.map((state) => [state, 0]));
  const names = new Map();
  let answered = 0;
  let haunted = 0;
  for (const run of runs) {
    const found = extract(run.text);
    if (found.length) answered += 1;
    if (found.some(({ eco, name }) => registry.get(`${eco}:${name}`)?.state === 'ghost')) haunted += 1;
    for (const { eco, name } of found) names.set(`${eco}:${name}`, { eco, name });
  }
  let corroborated = 0;
  for (const key of names.keys()) {
    const verdict = registry.get(key);
    const state = verdict?.state ?? 'unknown';
    states[state] += 1;
    if (state === 'ghost' && verdict.corroborated) corroborated += 1;
  }
  return {
    questions: runs.length,
    answeredWithInstall: answered,
    noInstallCommand: runs.length - answered,
    answersWithGhost: haunted,
    ghostAnswerRate: pct(haunted, answered),
    distinctNames: names.size,
    states,
    ghostsCorroborated: corroborated,
    ghostNameRate: pct(states.ghost, names.size - states.unknown),
  };
}

export function summarize(runs, registry) {
  const models = [...new Set(runs.map((run) => run.model))];
  const summary = { generatedAt: new Date().toISOString(), models: {} };
  const ghostHashes = {};

  for (const model of models) {
    const mine = runs.filter((run) => run.model === model);
    const sweep = mine.filter((run) => run.round === 'sweep');
    const entry = { digest: sweep[0]?.digest ?? mine[0]?.digest, overall: tally(sweep, registry), byGroup: {} };
    for (const eco of ['npm', 'pip']) {
      for (const tier of ['mainstream', 'niche']) {
        entry.byGroup[`${eco}/${tier}`] = tally(sweep.filter((run) => run.eco === eco && run.tier === tier), registry);
      }
    }

    const sweepByTask = new Map(sweep.map((run) => [run.id, run]));

    const again = mine.filter((run) => run.round === 'determinism');
    if (again.length) {
      const namesOf = (run) => extract(run.text).map(({ name }) => name);
      const pairs = again.map((run) => [sweepByTask.get(run.id), run]).filter(([first]) => first);
      // A pair only counts if the first answer named something. Two answers
      // with no package at all agree, but not about a name.
      const comparable = pairs.filter(([first]) => namesOf(first).length > 0);
      const sameSet = ([first, second]) => [...namesOf(first)].sort().join(' ') === [...namesOf(second)].sort().join(' ');
      const ghosts = comparable.flatMap(([first, second]) => extract(first.text)
        .filter(({ eco, name }) => registry.get(`${eco}:${name}`)?.state === 'ghost')
        .map(({ name }) => namesOf(second).includes(name)));
      entry.determinism = {
        rerun: pairs.length,
        comparable: comparable.length,
        identicalText: pairs.filter(([first, second]) => first.text === second.text).length,
        sameNames: comparable.filter(sameSet).length,
        ghostsTracked: ghosts.length,
        ghostsRepeated: ghosts.filter(Boolean).length,
      };
    }

    const haunt = mine.filter((run) => run.round === 'haunt');
    if (haunt.length) {
      const returns = [];
      for (const [id, run] of sweepByTask) {
        const reruns = haunt.filter((other) => other.id === id);
        if (!reruns.length) continue;
        for (const { eco, name } of extract(run.text)) {
          if (registry.get(`${eco}:${name}`)?.state !== 'ghost') continue;
          const hits = reruns.filter((other) => extract(other.text).some((found) => found.eco === eco && found.name === name)).length;
          returns.push(hits);
        }
      }
      const seeds = HAUNT_SEEDS.length;
      entry.haunt = {
        ghostsTracked: returns.length,
        seeds,
        returnedEveryTime: returns.filter((hits) => hits === seeds).length,
        returnedAtLeastOnce: returns.filter((hits) => hits > 0).length,
        neverReturned: returns.filter((hits) => hits === 0).length,
        averageReturns: Math.round((returns.reduce((sum, hits) => sum + hits, 0) / returns.length) * 10) / 10,
        overall: tally(haunt, registry),
      };
    }

    for (const [round, field] of [['mirror', 'mirror'], ['mirror-valid', 'mirrorValid']]) {
      const mirror = mine.filter((run) => run.round === round);
      if (!mirror.length) continue;
      const count = (truth, answer) => mirror.filter((run) => run.truth === truth && parseYesNo(run.text) === answer).length;
      const row = (truth) => ({ total: mirror.filter((run) => run.truth === truth).length, yes: count(truth, 'yes'), no: count(truth, 'no'), unclear: count(truth, 'unclear') });
      const ghost = row('ghost');
      const alive = row('alive');
      entry[field] = { ghost, alive, accuracy: pct(ghost.no + alive.yes, ghost.total + alive.total) };
    }

    const appearances = new Map();
    for (const run of mine.filter((other) => !other.round.startsWith('mirror'))) {
      for (const { eco, name } of extract(run.text)) {
        if (registry.get(`${eco}:${name}`)?.state !== 'ghost') continue;
        const key = `${eco}:${name}`;
        const seen = appearances.get(key) ?? { eco, name, runs: 0 };
        seen.runs += 1;
        appearances.set(key, seen);
      }
    }
    for (const { eco, name, runs: count } of appearances.values()) {
      const hash = hashName(eco, name);
      ghostHashes[hash] ??= { eco, runs: 0, models: [] };
      ghostHashes[hash].runs += count;
      ghostHashes[hash].models.push(model);
    }
    entry.topGhosts = [...appearances.values()]
      .sort((a, b) => b.runs - a.runs)
      .slice(0, 24)
      .map(({ eco, name, runs: count }) => ({ eco, shape: redact(name), runs: count }));
    summary.models[model] = entry;
  }

  const shared = Object.values(ghostHashes).filter((entry) => entry.models.length > 1).length;
  summary.sharedGhosts = shared;
  summary.occupied = [...registry.values()].filter((verdict) => verdict.state === 'possessed').length;
  return { summary, ghosts: { takenAt: summary.generatedAt, hashes: ghostHashes } };
}

export function writeSummary() {
  const runs = loadRuns();
  const registry = loadRegistry();
  // A fresh clone has the published summary but not the raw data behind it, and
  // `check` depends on ghosts.json, so an empty rebuild must not replace them.
  if (runs.length === 0 || registry.size === 0) {
    throw new Error('No local census data, so the published summary was left alone. Run the census and `census resolve` first.');
  }
  const { summary, ghosts } = summarize(runs, registry);
  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  writeFileSync(GHOSTS_PATH, JSON.stringify(ghosts, null, 2));
  return summary;
}
