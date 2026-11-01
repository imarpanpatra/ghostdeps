// The published form of the census. A name someone can register is an attack
// surface, so the repo carries hashes: you can ask "is this name a known
// ghost?" without being handed a shopping list.
//
// This is a speed bump, not a vault. Anyone with the weights can regenerate the
// list, and anyone with a guess can hash it. It only means this repo doesn't
// save them the afternoon.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export const GHOSTS_PATH = new URL('../data/ghosts.json', import.meta.url);

export const hashName = (eco, name) => createHash('sha256').update(`${eco}:${name}`).digest('hex');

// Keeps the separators, so the shape of the name survives, and shows at most
// the first third of its letters.
export function redact(name) {
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/') + 1) : '';
  const bare = name.slice(scope.length);
  const letters = bare.replace(/[-_.]/g, '').length;
  let shown = Math.floor(letters / 3);
  const masked = [...bare].map((char) => {
    if (/[-_.]/.test(char)) return char;
    if (shown > 0) { shown -= 1; return char; }
    return '█';
  }).join('');
  return `${scope ? `@${'█'.repeat(scope.length - 2)}/` : ''}${masked}`;
}

export function loadGhosts(path = GHOSTS_PATH) {
  if (!existsSync(path)) return { takenAt: null, hashes: {} };
  return JSON.parse(readFileSync(path, 'utf8'));
}

export const lookup = (census, eco, name) => census.hashes[hashName(eco, name)] ?? null;
