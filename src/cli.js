#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { writeSummary } from './analyze.js';
import { buildPrompt, loadRegistry, loadRuns, PATHS, runRound } from './census.js';
import { extract } from './extract.js';
import { loadGhosts, redact } from './ghosts.js';
import { generate } from './ollama.js';
import { classifyAll } from './registry.js';
import { writeReport } from './report.js';
import { exitCode, gatherInputs, printable, scan } from './scan.js';

const USAGE = `ghostdeps: a census of the packages that only exist inside a model

  ghostdeps summon "<task>" [--eco npm|pip] [--model gemma3:4b] [--redact]
      Ask the local model for a package, then ask the registry if it is real.

  ghostdeps check [file...]
      Check a package.json, a requirements file, or a pasted model answer
      (files, or stdin). Exit 0 clean, 1 trouble, 2 could not find out.

  ghostdeps census <sweep|resolve|determinism|haunt|mirror> [--model gemma3:4b]
      Run one round of the study. Safe to stop and rerun.

  ghostdeps analyze      Rebuild data/summary.json and data/ghosts.json.
  ghostdeps report       Rebuild docs/index.html from the summary.
  ghostdeps watch        Re-ask the registry about every local ghost.
`;

const [command, ...args] = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

const flag = (name) => args.includes(`--${name}`);

const paint = (code, text) => (process.stdout.isTTY || process.env.FORCE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const STYLE = {
  alive: ['32', 'alive'],
  ghost: ['1;35', 'GHOST'],
  possessed: ['1;31', 'POSSESSED'],
  dead: ['33', 'dead'],
  tombstone: ['33', 'tombstone'],
  exorcised: ['1;31', 'EXORCISED'],
  unknown: ['36', 'unknown'],
};
const MEANING = {
  alive: 'real, and the registry agrees',
  ghost: 'no such name on the registry, and deps.dev has no memory of it',
  possessed: 'something moved in recently, read it before you run it',
  dead: 'real, but deprecated by its maintainer',
  tombstone: 'existed once, then was removed',
  exorcised: 'npm seized it, it was probably malware',
  unknown: 'the registry gave no usable answer, so nothing is proven',
};

function printVerdicts(results, { hide = false } = {}) {
  const width = Math.max(...results.map(({ name }) => name.length), 8);
  for (const { eco, name, state, detail, census, corroborated } of results) {
    const [code, label] = STYLE[state];
    const shown = (hide && state === 'ghost' ? redact(name) : name).padEnd(width);
    const meaning = corroborated === false ? 'no such name on the registry, deps.dev could not be reached to confirm' : MEANING[state];
    const note = [detail ?? meaning, census ? `seen ${census.runs}x in the census` : null].filter(Boolean).join('; ');
    console.log(`  ${paint(code, label.padEnd(10))} ${printable(shown)}  ${paint('2', `${eco}: ${printable(note)}`)}`);
  }
}

function printTally(results) {
  const counts = {};
  for (const { state } of results) counts[state] = (counts[state] ?? 0) + 1;
  console.log(`\n${results.length} checked: ${Object.entries(counts).map(([state, count]) => `${count} ${state}`).join(', ')}`);
}

async function summon() {
  const task = args.find((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'));
  if (!task) throw new Error('Tell me what you are trying to do: ghostdeps summon "parse Apple Wallet files"');
  const eco = option('eco', 'npm');
  const model = option('model', 'gemma3:4b');
  const prompt = buildPrompt(eco, task);
  console.log(paint('2', `> ${prompt}\n`));
  const hide = flag('redact');
  const names = new Set();
  const mask = (text) => {
    let masked = text;
    for (const name of names) masked = masked.replaceAll(name, redact(name));
    return masked;
  };
  const { text } = await generate({ model, prompt, numPredict: 400 });
  for (const { raw, name } of extract(text)) names.add(raw).add(name);
  process.stdout.write(`${hide ? mask(text) : text}\n\n`);

  const found = extract(text);
  if (!found.length) {
    console.log('It did not give an install command this time.');
    return;
  }
  printVerdicts(await scan(found), { hide });
}

async function check() {
  const files = args.filter((arg) => !arg.startsWith('--'));
  if (!files.length && process.stdin.isTTY) {
    console.log(USAGE);
    process.exitCode = 2;
    return;
  }
  const { names, problems, manifests, prose } = gatherInputs(files, (file) => readFileSync(file ?? 0));
  for (const problem of problems) console.error(problem);
  if (!names.length) {
    const empty = manifests > 0 && problems.length === 0;
    console.log(empty ? 'No registry packages listed.' : 'No package names found, so nothing was checked.');
    process.exitCode = empty ? 0 : 2;
    return;
  }
  const results = await scan(names);
  printVerdicts(results);
  printTally(results);
  if (problems.length) console.log(`${problems.length} input(s) could not be read, so this result is incomplete.`);
  if (prose) console.log('This was read from prose, so a command it could not recognise is not ruled out.');
  process.exitCode = exitCode(results, problems.length);
}

async function watch() {
  const before = loadRegistry();
  const ghosts = [...before].filter(([, verdict]) => verdict.state === 'ghost').map(([key]) => {
    const split = key.indexOf(':');
    return { eco: key.slice(0, split), name: key.slice(split + 1) };
  });
  const now = await classifyAll(ghosts);
  const moved = now.filter(({ state }) => state !== 'ghost' && state !== 'unknown');
  const silent = now.filter(({ state }) => state === 'unknown').length;
  console.log(`${ghosts.length} ghosts re-checked, ${moved.length} no longer empty.`);
  if (silent) console.log(`${silent} could not be checked, so they prove nothing either way.`);
  if (moved.length) printVerdicts(moved);
  process.exitCode = moved.length ? 1 : silent ? 2 : 0;
}

// A failure here is a tool problem, not a verdict on anyone's packages, so it
// must not share exit 1 with "found a ghost".
try {
  if (command === 'summon') await summon();
  else if (command === 'check') await check();
  else if (command === 'census') await runRound(args[0], option('model', 'gemma3:4b'));
  else if (command === 'analyze') console.log(JSON.stringify(writeSummary().models, null, 2));
  else if (command === 'report') console.log(writeReport());
  else if (command === 'watch') await watch();
  else {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(`ghostdeps: ${error.message}`);
  process.exitCode = 2;
}
