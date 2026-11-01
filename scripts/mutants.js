// Breaks one guard at a time on a throwaway copy and checks a test notices. A
// mutant that survives is a guard nothing depends on, or a test that proves less
// than it claims. One that cannot be applied counts as a failure, not a pass.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), 'ghostdeps-mutants-'));

const MUTANTS = [
  // Registry evidence
  ['rate limit counts as ghost', 'src/registry.js', "if (doc.status !== 200) return { state: 'unknown', detail: `npm answered ${doc.status}` };", "if (doc.status !== 200) return { state: 'ghost' };"],
  ['network error counts as 404', 'src/registry.js', 'return { status: 0, error: error.message };', 'return { status: 404 };'],
  ['pypi rate limit counts as ghost', 'src/registry.js', "if (doc.status !== 200) return { state: 'unknown', detail: `PyPI answered ${doc.status}` };", "if (doc.status !== 200) return { state: 'ghost' };"],
  ['no tombstone check', 'src/registry.js', 'if (time.unpublished) return', 'if (false) return'],
  ['exorcised ignores description', 'src/registry.js', "&& /security holding/i.test(`${description} ${doc.body.readme ?? ''}`)", ''],
  ['no exorcised check', 'src/registry.js', "return { state: 'exorcised', created };", ''],
  ['deprecated ignored', 'src/registry.js', "return deprecated ? { state: 'dead', created, detail: String(deprecated).slice(0, 120) } : { state: 'alive', created };", "return { state: 'alive', created };"],
  ['deprecation dodges possessed', 'src/registry.js', 'if (!isYoung(createdAt, now)) return healthy();', 'if (versions[latest].deprecated || !isYoung(createdAt, now)) return healthy();'],
  ['young without stats is alive', 'src/registry.js', "if (stats.status !== 200) return { state: 'unknown', created, detail: `npm downloads answered ${stats.status}` };", "if (stats.status !== 200) return { state: 'alive', created };"],
  ['possessed threshold inverted', 'src/registry.js', 'return downloads < FEW_DOWNLOADS', 'return downloads >= FEW_DOWNLOADS'],
  ['popular and deprecated reads alive', 'src/registry.js', ': { ...healthy(), downloads };', ": { state: 'alive', created, downloads };"],
  ['pip age from latest upload', 'src/registry.js', 'Math.min(...uploads)', 'Math.max(...uploads)'],
  ['pip yanked ignored', 'src/registry.js', 'if (files.every((file) => file.yanked)) return', 'if (false) return'],
  ['pip release count ignored', 'src/registry.js', 'if (isYoung(createdAt, now) && releases.length <= FEW_RELEASES) {', 'if (isYoung(createdAt, now)) {'],
  ['yank dodges possessed', 'src/registry.js', 'if (isYoung(createdAt, now) && releases.length <= FEW_RELEASES) {', 'if (!doc.body.info?.yanked && isYoung(createdAt, now) && releases.length <= FEW_RELEASES) {'],
  ['pip latest yank ignored', 'src/registry.js', "return doc.body.info?.yanked ? { state: 'dead', created, detail: 'latest release yanked' } : { state: 'alive', created };", "return { state: 'alive', created };"],
  ['scoped name not encoded', 'src/registry.js', "name.replace('/', '%2f')", 'name'],
  ['cache not reused', 'src/registry.js', 'items.filter(({ eco, name }) => !cache.has(`${eco}:${name}`))', '[...items]'],
  ['deps.dev memory ignored', 'src/registry.js', 'if (record.status === 200 && record.body.versions?.length) {', 'if (false) {'],
  ['deps.dev empty record trusted', 'src/registry.js', 'record.status === 200 && record.body.versions?.length', 'record.status === 200'],
  ['unconfirmed ghost claims corroboration', 'src/registry.js', 'corroborated: record.status === 404', 'corroborated: true'],
  ['npm ghosts skip deps.dev', 'src/registry.js', "if (doc.status === 404) return confirmGhost(fetchImpl, 'npm', name);", "if (doc.status === 404) return { state: 'ghost' };"],
  ['pypi ghosts skip deps.dev', 'src/registry.js', "if (doc.status === 404) return confirmGhost(fetchImpl, 'pypi', name);", "if (doc.status === 404) return { state: 'ghost' };"],

  // Answer parsing
  ['plain text read by the census', 'src/extract.js', 'if (bare) for (const line of plain) commandsIn(line, true, emit, bare);', 'for (const line of plain) commandsIn(line, true, emit, bare);'],
  ['plain text never read', 'src/extract.js', 'if (bare) for (const line of plain) commandsIn(line, true, emit, bare);', ''],
  ["HTML left in plain text", "src/extract.js", "bare ? text.replace(/<\\/?(?:pre|code)\\b[^>]*>/gi, '') : text", "text"],
  ["plain text not held to prose rule", "src/extract.js", "else if (isProse(token)) reading = false;", ""],
  ["code not held to prose rule", "src/extract.js", "} else if (wanted.length > 0 && isProse(wanted[0]) && wanted.filter(isProse).length >= 2) {", "} else if (false) {"],
  ["one English word kills a command", "src/extract.js", "isProse(wanted[0]) && wanted.filter(isProse).length >= 2", "wanted.some(isProse)"],
  ['placeholders accepted', 'src/extract.js', 'return PLACEHOLDERS.has(token.toLowerCase()) || PLACEHOLDER_SCOPED.test(token) ? null : token;', 'return token;'],
  ['scoped placeholders accepted', 'src/extract.js', 'return PLACEHOLDERS.has(token.toLowerCase()) || PLACEHOLDER_SCOPED.test(token) ? null : token;', 'return PLACEHOLDERS.has(token.toLowerCase()) ? null : token;'],
  ['placeholder scope becomes a namespace', 'src/extract.js', '\\/(?:your|my|some|example)?[-_]?(?:package|pkg|lib|library|module)(?:[-_]name)?$/i', '\\//i'],
  ['pep503 skipped', 'src/extract.js', "return eco === 'pip' ? name.toLowerCase().replace(/[-_.]+/g, '-') : name;", 'return name;'],
  ["comment commands ignored", "src/extract.js", "(comment ? comment[1] : rawLine)", "(comment ? '' : rawLine)"],
  ["comment sentences read as commands", "src/extract.js", "if (comment && !loose && !COMMAND_LEAD.test(command.slice(0, match.index))) continue;", ""],
  ['value flags read as packages', 'src/extract.js', '} else if (VALUE_FLAGS[tool].has(token)) {', '} else if (false) {'],
  ['npm -f takes a value', 'src/extract.js', "npm: new Set([...JS_VALUE_FLAGS, '-w']),", "npm: new Set([...JS_VALUE_FLAGS, '-w', '-f']),"],
  ['pnpm -w takes a value', 'src/extract.js', 'pnpm: new Set(JS_VALUE_FLAGS),', "pnpm: new Set([...JS_VALUE_FLAGS, '-w']),"],
  ['only the first command on a line', 'src/extract.js', 'for (const piece of line.split(/&&|\\|\\||[|;]|\\s#/)) {', 'for (const piece of line.split(/&&|\\|\\||[|;]|\\s#/).slice(0, 1)) {'],
  ['shell separators ignored', 'src/extract.js', 'for (const piece of line.split(/&&|\\|\\||[|;]|\\s#/)) {', 'for (const piece of [line]) {'],
  ["continuations dropped", "src/extract.js", "if (!/^\\s*(?:#|\\/\\/)/.test(line) && CONTINUATION.test(line)) {", "if (false) {"],
  ['npm version kept', 'src/extract.js', "token = token.replace(/(?<=.)@[^/]*$/, '');", ''],
  ['pip extras kept', 'src/extract.js', "token = token.replace(/\\[.*$/, '').replace(/[=<>~!;].*$/, '').trim();", ''],
  ['alias checks the local name', 'src/extract.js', 'token = token.match(/^(?:@[^/]+\\/)?[^@]+@npm:(.+)$/)?.[1] ?? token;', ''],
  ['npm archives read as names', 'src/extract.js', 'if (/\\.(?:tgz|tar\\.gz|tar)$/i.test(token)) return null;', ''],
  ['pip archives read as names', 'src/extract.js', 'if (/\\.(?:whl|tar\\.gz|tar\\.bz2|tgz|zip)$/i.test(token)) return null;', ''],
  ['inline code ignored', 'src/extract.js', 'code.push(...inline.spans);', ''],
  ['shell prompts ignored', 'src/extract.js', '/^\\s*(?:\\(\\S+\\)\\s*)?(?:PS\\s+)?(?:[a-z]:\\\\[^>]*>|\\S*[$%])\\s+\\S/i.test(inline.plain)', 'false'],
  ['indented code ignored', 'src/extract.js', '/^(?: {4}|\\t)/.test(inline.plain) && startsWithInstaller(inline.plain.trim())', 'false'],
  ['blockquoted prose read as code', 'src/extract.js', '(startsWithInstaller(quoted[1]) ? code : plain).push(quoted[1]);', 'code.push(quoted[1]);'],
  ['tilde fences ignored', 'src/extract.js', '(`{3,}|~{3,})', '(`{3,})'],
  ['one-line backticks open a fence', 'src/extract.js', "} else if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {", '} else if (fence) {'],
  ["redirects read as packages", "src/extract.js", "if (REDIRECT.test(token)) {", "if (false) {"],
  ['quotes ignored', 'src/extract.js', `rest.match(/"[^"]*"|'[^']*'|\\S+/g)`, 'rest.match(/\\S+/g)'],
  ['long tokens parsed', 'src/extract.js', 'if (raw.length > MAX_NAME) return null;', ''],
  ["a runner reads all its arguments", "src/extract.js", "...(named.length > 0 ? named : wanted.slice(0, 1))", "...(named.length > 0 ? named : wanted)"],
  ["runners ignored", "src/extract.js", "String.raw`npx|bunx|pnpx|(?:pnpm|yarn)\\s+dlx|npm\\s+(?:exec|x)|bun\\s+x`, 'run'", "String.raw`npx-never`, 'run'"],
  ['stop ignores open fence', 'src/census.js', 'return fences % 2 === 0 && /\\n\\s*$/.test(text)', 'return /\\n\\s*$/.test(text)'],

  // Census and masking
  ['census ignores ecosystem', 'src/ghosts.js', 'update(`${eco}:${name}`)', 'update(name)'],
  ['redaction shows half', 'src/ghosts.js', 'Math.floor(letters / 3)', 'Math.ceil(letters / 2)'],
  ['scope left visible', 'src/ghosts.js', "`@${'█'.repeat(scope.length - 2)}/`", 'scope'],
  ['census cannot possess', 'src/scan.js', "return { ...known, state: 'possessed', detail: `was a ghost on ${census.takenAt.slice(0, 10)}, exists now` };", 'return known;'],
  ['deprecation dodges the census', 'src/scan.js', "if (result.state !== 'alive' && result.state !== 'dead') return known;", "if (result.state !== 'alive') return known;"],

  // Input handling
  ['unknown exits clean', 'src/scan.js', "if (unreadable > 0 || results.some(({ state }) => state === 'unknown')) return 2;", 'if (unreadable > 0) return 2;'],
  ['unreadable exits clean', 'src/scan.js', "if (unreadable > 0 || results.some(({ state }) => state === 'unknown')) return 2;", "if (results.some(({ state }) => state === 'unknown')) return 2;"],
  ['exorcised exits clean', 'src/scan.js', "['ghost', 'possessed', 'tombstone', 'exorcised']", "['ghost', 'possessed', 'tombstone']"],
  ['manifest alias checked under local name', 'src/scan.js', "if (spec.startsWith('npm:')) return spec.slice(4).replace(/(?<=.)@[^/]*$/, '');", ''],
  ['file: deps sent to registry', 'src/scan.js', 'return /^(?:file:|link:|workspace:|git[+:]|https?:|github:)|\\//.test(spec) ? null : name;', 'return name;'],
  ['a git-like dist tag is skipped', 'src/scan.js', 'workspace:|git[+:]|https?:', 'workspace:|git|https?:'],
  ['UTF-16 not decoded', 'src/scan.js', "if (starts(0xff, 0xfe)) return buffer.subarray(2).toString('utf16le');", ''],
  ['big-endian UTF-16 not decoded', 'src/scan.js', "if (starts(0xfe, 0xff)) return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');", ''],
  ['BOM kept', 'src/scan.js', "if (starts(0xef, 0xbb, 0xbf)) return buffer.subarray(3).toString('utf8');", ''],
  ['binary accepted', 'src/scan.js', "if (buffer.includes(0)) throw new Error('it looks binary, or is UTF-16 with no byte order mark');", ''],
  ["requirements only by exact filename", "src/scan.js", "if (requirements || (filename && isRequirementsFile(filename)) || looksLikeRequirements(text)) {", "if (requirements || base === 'requirements.txt' || looksLikeRequirements(text)) {"],
  ["requirements only by filename", "src/scan.js", "if (requirements || (filename && isRequirementsFile(filename)) || looksLikeRequirements(text)) {", "if (requirements || (filename && isRequirementsFile(filename))) {"],
  ["requirements only by content", "src/scan.js", "if (requirements || (filename && isRequirementsFile(filename)) || looksLikeRequirements(text)) {", "if (requirements || looksLikeRequirements(text)) {"],
  ["paths read as requirements", "src/scan.js", "/^(?:[@/\\\\]|:[\\\\/.])/.test(match[2])", "false"],
  ["archives read as requirements", "src/scan.js", "|| ARCHIVE.test(match[1])", ""],
  ["requirement continuations ignored", "src/scan.js", "if (!/^\\s*#/.test(line) && /\\\\\\s*$/.test(line)) {", "if (false) {"],
  ['includes dropped', 'src/scan.js', 'includes.push(include[1]);', ''],
  ["manifests in answers ignored", "src/scan.js", ", ...manifestsInAnswer(text)]", "]"],
  ["any code block is a requirement", "src/scan.js", "return /^(?:requirements|pip)\\b/i.test(info) || /^#.*requirements/im.test(body) || PINNED_LINE.test(body);", "return true;"],
  ['invalid JSON tolerated', 'src/scan.js', "if (base.endsWith('.json') && json === undefined) throw new Error('it is not valid JSON');", ''],
  ['non-object manifest tolerated', 'src/scan.js', "if (base === 'package.json' && (json === null || typeof json !== 'object')) throw new Error('it is not a package manifest');", ''],
  ['no names exits clean', 'src/cli.js', 'process.exitCode = empty ? 0 : 2;', 'process.exitCode = 0;'],
  ["empty input read", "src/scan.js", "if (!text.trim()) throw new Error('it is empty');", ""],
  ["circular includes loop", "src/scan.js", "if (!seen.has(path)) queue.push({ file: path, included: true });", "queue.push({ file: path, included: true });"],
  ['a tool failure shares the trouble code', 'src/cli.js', 'console.error(`ghostdeps: ${error.message}`);\n  process.exitCode = 2;', 'console.error(`ghostdeps: ${error.message}`);\n  process.exitCode = 1;'],

  // Found by the second review
  ["commented lines continue", "src/extract.js", "if (!/^\\s*(?:#|\\/\\/)/.test(line) && CONTINUATION.test(line)) {", "if (CONTINUATION.test(line)) {"],
  ["a stuck backtick continues", "src/extract.js", "const CONTINUATION = /(?:\\\\|\\s[`^])\\s*$/;", "const CONTINUATION = /[\\\\`^]\\s*$/;"],
  ["plain text not joined", "src/extract.js", "for (const line of logicalLines(lines)) {\n    const inline", "for (const line of lines) {\n    const inline"],
  ["launcher breaks a comment", "src/extract.js", "!COMMAND_LEAD.test(command.slice(0, match.index))", "match.index > 0"],
  ["title case reads as a command", "src/extract.js", "if (strict && !readsAsCommand(match[0])) continue;", ""],
  ["comments held to the code rule", "src/extract.js", "const strict = careful || Boolean(comment);", "const strict = careful;"],
  ["attached redirect skips the next token", "src/extract.js", "if (DETACHED_REDIRECT.test(token)) i++;", "i++;"],
  ["detached redirect target read", "src/extract.js", "if (DETACHED_REDIRECT.test(token)) i++; // the next token is its target", ""],
  ["--package= ignored", "src/extract.js", "const attached = mode !== 'install' && token.match(/^--(?:package|from)=(.+)$/);", "const attached = false;"],
  ["--package not read", "src/extract.js", "const RUN_PACKAGE_FLAGS = new Set(['-p', '--package', '--from']);", "const RUN_PACKAGE_FLAGS = new Set(['-p']);"],
  ["-p at end of line crashes", "src/extract.js", "if (i + 1 < tokens.length) named.push(tokens[++i]);", "named.push(tokens[++i]);"],
  ["pipx shares the pip flags", "src/extract.js", "pipx: new Set(['--python', '--index-url', '-i', '--pip-args', '--suffix']),", "pipx: new Set(PIP_VALUE_FLAGS),"],
  ["uv -p read as a package", "src/extract.js", "uv: new Set([...PIP_VALUE_FLAGS, '-p']),", "uv: new Set(PIP_VALUE_FLAGS),"],
  ["bold hides a command", "src/extract.js", "=*\\[{@-])`;", "=@-])`;"],
  ["trailing ? stays on the name", "src/extract.js", "['\",;:).*`?!\\]}]+$", "['\",;:).*`]+$"],
  ["fence closes on a shorter run", "src/extract.js", "&& fence[1].length >= open.length ", ""],
  ["fence closes on the other character", "src/extract.js", "fence[1][0] === open.char && ", ""],
  ["fence closes with text after it", "src/extract.js", " && !fence[2].trim();", ";"],
  ["pnpm flags unbounded", "src/extract.js", "(?:(?:--filter|-F|--dir|-C)\\s+\\S+\\s+|-\\S+\\s+){0,6}", "(?:(?:--filter|-F|--dir|-C)\\s+\\S+\\s+|-\\S+\\s+)*"],
  ["commands sniffed as requirements", "src/scan.js", "&& extract(code, { bare: true }).length === 0;", ";"],
  ["bullet lines read as pip options", "src/scan.js", "} else if (/^-[a-zA-Z]\\S*(?:\\s|$)|^--[a-z]/.test(line)) {", "} else if (line.startsWith('-')) {"],
  ["attached -r ignored", "src/scan.js", "/^(?:-r\\s*|--requirement[\\s=]+)(\\S+)/", "/^(?:-r\\s+|--requirement[\\s=]+)(\\S+)/"],
  ["hash options break a requirement", "src/scan.js", ".replace(/\\s+--[a-z-]+(?:[=\\s]\\S+)?/g, '')", ""],
  ["requirement comments continue", "src/scan.js", "if (!/^\\s*#/.test(line) && /\\\\\\s*$/.test(line)) {", "if (/\\\\\\s*$/.test(line)) {"],
  ["any filename with req in it", "src/scan.js", "/^(?:.*[-_.])?req(?:uirement)?s?(?:[-_.].*)?\\.(?:txt|in)$/", "/req.*\\.(?:txt|in)$/"],
  ["requirements folder ignored", "src/scan.js", "|| /(?:^|[\\\\/])requirements[\\\\/][^\\\\/]+\\.(?:txt|in)$/i.test(filename)", ""],
  ["spaced == reads as a pin", "src/scan.js", "(?:===?|~=|!=|<=?|>=?)[^\\s=]/m", "\\s*(?:===?|~=|!=|<=?|>=?)\\s*[^\\s=]/m"],
  ["nameless file is not a problem", "src/scan.js", "if (kind === 'text' && found.length === 0) throw new Error('no package names in it');", ""],
  ["includes judged by content", "src/scan.js", "readManifest(file, text, { requirements: included })", "readManifest(file, text)"],
  ["stdin includes silently dropped", "src/scan.js", "if (file === null) throw new Error(`it includes ${include}, which can't be followed from stdin`);", "if (file === null) continue;"],
  ["escape codes printed", "src/scan.js", ".replace(/[\\u0000-\\u001f\\u007f-\\u009f]/g, '?')", ""],
  ["problem paths not cleaned", "src/scan.js", "printable(file ?? 'stdin')", "(file ?? 'stdin')"],

  // Found by the third review
  ["only the first installer on a line", "src/extract.js", "const end = hits[index + 1]?.match.index ?? command.length;", "const end = command.length;"],
  ["conjunctions do not resume reading", "src/extract.js", "if (resume && CONJUNCTIONS.has(word(token))) reading = true;\n      else if", "if"],
  ["digits ignored in prose words", "src/extract.js", "token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')", "token.toLowerCase().replace(/[^a-z]/g, '')"],
  ["shouted commands dropped", "src/extract.js", "return verb === verb.toLowerCase() || (words[0] === words[0].toUpperCase() && verb === verb.toUpperCase());", "return verb === verb.toLowerCase();"],
  ["workspace name trips the case rule", "src/extract.js", "const verb = words.at(-1);", "const verb = words.join(' ');"],
  ["lead-in comments unread by check", "src/extract.js", "if (comment && !loose && !COMMAND_LEAD", "if (comment && !COMMAND_LEAD"],
  ["lead-in comments read by the census", "src/extract.js", "commandsIn(body, false, emit, bare);", "commandsIn(body, false, emit, true);"],
  ["create names not prefixed", "src/extract.js", "return mode === 'create' ? names.map(createPackage) : names;", "return names;"],
  ["create scope misplaced", "src/extract.js", "name.replace(/^(@[^/]+\\/)?(.*)$/, '$1create-$2')", "`create-${name}`"],
  ["uv run reads its script", "src/extract.js", "if (mode === 'flagged') wanted = extra;\n  else if", "if"],
  ["comments stop the sniffing", "src/scan.js", "const code = text.split(/\\r?\\n/).map((line) => line.replace(/(?:^|\\s)#.*$/, '')).join('\\n');", "const code = text;"],
  ["prose result not flagged", "src/scan.js", "      else prose = true;\n", ""],

  // Found by the final review
  ["conjunctions resume in the census", "src/extract.js", "if (resume && CONJUNCTIONS.has(word(token))) reading = true;", "if (CONJUNCTIONS.has(word(token))) reading = true;"],
  ["--with= ignored", "src/extract.js", "const attachedWith = mode !== 'install' && token.match(/^--with=(.+)$/);", "const attachedWith = false;"],
  ["--with not read", "src/extract.js", "} else if (mode !== 'install' && token === '--with') {", "} else if (false) {"],
  ["--with replaces the tool", "src/extract.js", "wanted = [...extra, ...(named.length > 0 ? named : wanted.slice(0, 1))];", "wanted = extra.length > 0 ? extra : (named.length > 0 ? named : wanted.slice(0, 1));"],
  ["npm value flag hides the verb", "src/extract.js", "(?:(?:--prefix|--workspace|-w)\\s+\\S+\\s+|-\\S+\\s+){0,6}", "(?:-\\S+\\s+){0,6}"],
  ["yarn value flag hides the verb", "src/extract.js", "(?:--cwd\\s+\\S+\\s+|-\\S+\\s+){0,6}", "(?:-\\S+\\s+){0,6}"],
  ["make prefixes hide the command", "src/extract.js", "=*\\[{@-])`;", "=*\\[{])`;"],
  ["list-form commands unread", "src/extract.js", ".replace(/([\"'])\\s*,\\s*\\1/g, ' ')", ""],
  ["runner name steals the arguments", "src/extract.js", "const hits = found.filter(({ entry, match }, index) => index === 0 || entry.mode === 'install'\n    || /(?:\\b(?:and|or|then)|[.,:])\\s*$/i.test(command.slice(0, match.index)));", "const hits = found;"],
  ["a later runner is never read", "src/extract.js", "\n    || /(?:\\b(?:and|or|then)|[.,:])\\s*$/i.test(command.slice(0, match.index)));", ");"],

  // Published numbers
  ['empty answers count as a match', 'src/analyze.js', 'const comparable = pairs.filter(([first]) => namesOf(first).length > 0);', 'const comparable = pairs;'],
  ['name order matters', 'src/analyze.js', "[...namesOf(first)].sort().join(' ') === [...namesOf(second)].sort().join(' ')", "namesOf(first).join(' ') === namesOf(second).join(' ')"],
  ['ghosts always repeat', 'src/analyze.js', '.map(({ name }) => namesOf(second).includes(name)));', '.map(() => true));'],
  ['orphan repeat crashes', 'src/analyze.js', '.filter(([first]) => first);', ';'],
  ['empty rebuild overwrites the census', 'src/analyze.js', 'if (runs.length === 0 || registry.size === 0) {', 'if (false) {'],
  ['report crashes with no primary sweep', 'src/report.js', 'if (!entry) throw new Error(`The summary has no ${PRIMARY} sweep, so there is nothing to report.`);', ''],
];

for (const dir of ['src', 'test']) cpSync(join(SRC, dir), join(WORK, dir), { recursive: true });
cpSync(join(SRC, 'package.json'), join(WORK, 'package.json'));
mkdirSync(join(WORK, 'data'));
cpSync(join(SRC, 'data/tasks.json'), join(WORK, 'data/tasks.json'));

// The leak test reads git, and the copy isn't a repo. It has its own planted test.
const TESTS = readdirSync(join(WORK, 'test')).filter((file) => file !== 'leak.test.js').map((file) => join('test', file));
const runTests = () => spawnSync(process.execPath, ['--test', ...TESTS], { cwd: WORK, encoding: 'utf8', timeout: 90_000 }).status === 0;

if (!runTests()) {
  rmSync(WORK, { recursive: true, force: true });
  throw new Error('Baseline is red.');
}

let survived = 0;
for (const [label, file, from, to] of MUTANTS) {
  const path = join(WORK, file);
  const original = readFileSync(path, 'utf8');
  if (!original.includes(from)) {
    console.log(`NOT APPLIED  ${label}`);
    survived += 1;
    continue;
  }
  writeFileSync(path, original.replace(from, () => to));
  const passed = runTests();
  writeFileSync(path, original);
  if (passed) survived += 1;
  console.log(`${passed ? 'SURVIVED   ' : 'killed     '} ${label}`);
}
rmSync(WORK, { recursive: true, force: true });
console.log(`\n${MUTANTS.length} mutants, ${survived} survived or failed to apply.`);
process.exitCode = survived ? 1 : 0;
