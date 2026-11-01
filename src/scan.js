// `ghostdeps check`: reads whatever you point it at and asks the registry about
// every name in it. The model plays no part here, so a verdict never depends on
// the thing that invented the problem.

import { basename, dirname, resolve } from 'node:path';
import { extract, normalize, parseBlocks } from './extract.js';
import { loadGhosts, lookup } from './ghosts.js';
import { classifyAll } from './registry.js';

const DEPENDENCY_GROUPS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/;
const SPECIFIER = /^(?:===?|~=|!=|<=?|>=?)\s*[^\s,;]+$/;
const PINNED_LINE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]*\])?(?:===?|~=|!=|<=?|>=?)[^\s=]/m;
const ARCHIVE = /\.(?:whl|tar\.gz|tar\.bz2|tgz|zip)$/i;

// Registry text and file paths can hold escape codes that would redraw the
// terminal, for instance to paint over a GHOST row.
export const printable = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');

// PowerShell 5.1 writes UTF-16 with a BOM, and read as UTF-8 that is a string of
// NULs with no package in it, which used to come out as "clean".
export function decodeInput(buffer) {
  const starts = (...bytes) => bytes.every((byte, index) => buffer[index] === byte);
  if (starts(0xef, 0xbb, 0xbf)) return buffer.subarray(3).toString('utf8');
  if (starts(0xff, 0xfe)) return buffer.subarray(2).toString('utf16le');
  if (starts(0xfe, 0xff)) return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  if (buffer.includes(0)) throw new Error('it looks binary, or is UTF-16 with no byte order mark');
  return buffer.toString('utf8');
}

// file:, git+, github: and workspace: never touch the registry. An npm: alias
// does, under the name after the colon, which is the one that has to exist.
function registryName(name, spec) {
  if (spec.startsWith('npm:')) return spec.slice(4).replace(/(?<=.)@[^/]*$/, '');
  return /^(?:file:|link:|workspace:|git[+:]|https?:|github:)|\//.test(spec) ? null : name;
}

function dependencyNames(manifest) {
  const entries = DEPENDENCY_GROUPS.flatMap((group) => Object.entries(manifest[group] ?? {}));
  const names = entries.map(([name, spec]) => registryName(name, String(spec))).filter(Boolean);
  return [...new Set(names)].map((name) => ({ eco: 'npm', name }));
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isManifest = (value) => value !== null && typeof value === 'object' && DEPENDENCY_GROUPS.some((group) => group in value);

// pip joins continuations before it strips comments, except that a comment line
// never continues.
function requirementLines(text) {
  const lines = [];
  let pending = '';
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*#/.test(line) && /\\\s*$/.test(line)) {
      pending += line.replace(/\\\s*$/, '');
    } else {
      lines.push(pending + line);
      pending = '';
    }
  }
  if (pending) lines.push(pending);
  return lines;
}

function validSpecifiers(rest) {
  return rest.split(';')[0].split(',').every((part) => !part.trim() || SPECIFIER.test(part.trim()));
}

// One requirement per line. Paths, archives and direct URLs never reach the
// index, so they are skipped. Anything that isn't valid pip syntax is counted,
// which is what lets the caller tell a requirements file from a chat answer.
function parseRequirements(text) {
  const packages = [];
  const includes = [];
  let invalid = 0;
  for (const raw of requirementLines(text)) {
    const line = raw.replace(/(?:^|\s)#.*$/, '').trim();
    const include = line.match(/^(?:-r\s*|--requirement[\s=]+)(\S+)/);
    if (include) {
      includes.push(include[1]);
    } else if (/^-[a-zA-Z]\S*(?:\s|$)|^--[a-z]/.test(line)) {
      continue;
    } else if (line) {
      const match = line.replace(/\s+--[a-z-]+(?:[=\s]\S+)?/g, '').match(REQUIREMENT);
      const offIndex = match && (/^(?:[@/\\]|:[\\/.])/.test(match[2]) || ARCHIVE.test(match[1]));
      if (match && !offIndex) packages.push(normalize('pip', match[1]));
      if (!match || (!offIndex && !validSpecifiers(match[2]))) invalid += 1;
    }
  }
  const names = [...new Set(packages)].map((name) => ({ eco: 'pip', name }));
  return { names, includes, invalid };
}

// Needs positive evidence, because every word of a short chat answer can pass
// for an unpinned requirement, and misreading one skips the parser built for it.
// Comments don't count against it: real files carry `# pip install -U pip`.
function looksLikeRequirements(text) {
  const { names, includes, invalid } = parseRequirements(text);
  const code = text.split(/\r?\n/).map((line) => line.replace(/(?:^|\s)#.*$/, '')).join('\n');
  return invalid === 0 && names.length + includes.length > 0 && extract(code, { bare: true }).length === 0;
}

const isRequirementsFile = (filename) => /^(?:.*[-_.])?req(?:uirement)?s?(?:[-_.].*)?\.(?:txt|in)$/.test(basename(filename).toLowerCase())
  || /(?:^|[\\/])requirements[\\/][^\\/]+\.(?:txt|in)$/i.test(filename);

// Regex, not JSON.parse: chat answers show fragments, comments and `...`.
function dependenciesInBlock(body) {
  const names = [];
  for (const block of body.matchAll(/"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{([^{}]*)\}/g)) {
    for (const [, name, spec] of block[1].matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)) {
      const resolved = registryName(name, spec);
      if (resolved) names.push({ eco: 'npm', name: resolved });
    }
  }
  return names;
}

function isRequirementsBlock(info, body) {
  if (!looksLikeRequirements(body)) return false;
  return /^(?:requirements|pip)\b/i.test(info) || /^#.*requirements/im.test(body) || PINNED_LINE.test(body);
}

// A chatbot often answers with a manifest in a code block instead of a command.
function manifestsInAnswer(text) {
  const names = [];
  for (const { info, body } of parseBlocks(text).blocks) {
    names.push(...dependenciesInBlock(body));
    if (isRequirementsBlock(info, body)) names.push(...parseRequirements(body).names);
  }
  return names;
}

// Decides what a piece of input is from its name, then its content, so a piped
// requirements file or a package.prod.json can't fall through to the answer
// parser and come back empty.
export function readManifest(filename, text, { requirements = false } = {}) {
  const base = basename(filename ?? '').toLowerCase();
  const json = tryJson(text);
  if (base.endsWith('.json') && json === undefined) throw new Error('it is not valid JSON');
  if (base === 'package.json' && (json === null || typeof json !== 'object')) throw new Error('it is not a package manifest');
  if (base === 'package.json' || isManifest(json)) return { kind: 'npm', names: dependencyNames(json), includes: [] };
  if (requirements || (filename && isRequirementsFile(filename)) || looksLikeRequirements(text)) {
    const { names, includes } = parseRequirements(text);
    return { kind: 'pip', names, includes };
  }
  const names = [...extract(text, { bare: true }).map(({ eco, name }) => ({ eco, name })), ...manifestsInAnswer(text)];
  return { kind: 'text', names, includes: [] };
}

// Reads every input and follows `-r` includes. An input that can't be read, or
// that isn't a manifest and yields no names, is a problem, because a run that
// skipped something can't report clean. `read(null)` is stdin. `prose` records
// that some input had no grammar, so a clean result only covers what was seen.
export function gatherInputs(files, read) {
  const queue = files.length ? files.map((file) => ({ file })) : [{ file: null }];
  const seen = new Set(files);
  const names = new Map();
  const problems = [];
  let manifests = 0;
  let prose = false;
  while (queue.length) {
    const { file, included } = queue.shift();
    try {
      const text = decodeInput(read(file));
      if (!text.trim()) throw new Error('it is empty');
      const { kind, names: found, includes } = readManifest(file, text, { requirements: included });
      if (kind === 'text' && found.length === 0) throw new Error('no package names in it');
      if (kind !== 'text') manifests += 1;
      else prose = true;
      for (const entry of found) names.set(`${entry.eco}:${entry.name}`, entry);
      for (const include of includes) {
        if (file === null) throw new Error(`it includes ${include}, which can't be followed from stdin`);
        const path = resolve(dirname(file), include);
        if (!seen.has(path)) queue.push({ file: path, included: true });
        seen.add(path);
      }
    } catch (error) {
      problems.push(`Could not read ${printable(file ?? 'stdin')}: ${error.code === 'ENOENT' ? 'no such file' : printable(error.message)}.`);
    }
  }
  return { names: [...names.values()], problems, manifests, prose };
}

// Exists now, but the census watched it not exist. That outranks download
// counts: a squatter can buy downloads, but not a past. A deprecation can be
// bought too, so `dead` doesn't get a name out of this either.
export function applyCensus(result, census) {
  const entry = lookup(census, result.eco, result.name);
  if (!entry) return result;
  const known = { ...result, census: entry };
  if (result.state !== 'alive' && result.state !== 'dead') return known;
  return { ...known, state: 'possessed', detail: `was a ghost on ${census.takenAt.slice(0, 10)}, exists now` };
}

export async function scan(names, options = {}) {
  const census = options.census ?? loadGhosts();
  const results = await classifyAll(names, options);
  return results.map((result) => applyCensus(result, census));
}

// 0 clean, 1 something is wrong, 2 we could not find out. Exit 2 exists so CI
// never reads "the registry was down" as "your dependencies are fine".
export function exitCode(results, unreadable = 0) {
  if (results.some(({ state }) => ['ghost', 'possessed', 'tombstone', 'exorcised'].includes(state))) return 1;
  if (unreadable > 0 || results.some(({ state }) => state === 'unknown')) return 2;
  return 0;
}
