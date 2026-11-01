// Pulls installable package names out of a model's answer.
//
// The census reads code only: a ghost counts if the model told you to install
// it, and "run npm install to fetch the dependencies" must never yield a
// package called "to". `check` passes `bare: true` as well, because a chatbot
// answer copied from a web page has lost its backticks, and missing a command
// there is worse than a false alarm.

const PREFIX = String.raw`(?:^|[\s(\x60$>"'!%/\\=*\[{@-])`;

const installer = (eco, tool, pattern, mode = 'install') => ({
  eco,
  tool,
  mode,
  re: new RegExp(`${PREFIX}(?:${pattern})(?=\\s|$)`, 'i'),
  all: new RegExp(`${PREFIX}(?:${pattern})(?=\\s|$)`, 'gi'),
});

// Flag runs are capped at six: an unbounded repeat here backtracks exponentially
// on a crafted line, and no real command needs more before its verb.
const INSTALLERS = [
  installer('npm', 'npm', String.raw`npm(?:\.cmd)?\s+(?:(?:--prefix|--workspace|-w)\s+\S+\s+|-\S+\s+){0,6}(?:install|i|add)`),
  installer('npm', 'yarn', String.raw`yarn\s+(?:--cwd\s+\S+\s+|-\S+\s+){0,6}(?:global\s+|workspace\s+\S+\s+)?add`),
  installer('npm', 'pnpm', String.raw`pnpm\s+(?:(?:--filter|-F|--dir|-C)\s+\S+\s+|-\S+\s+){0,6}(?:add|install|i)`),
  installer('npm', 'bun', String.raw`bun\s+(?:add|install|i|a)`),
  installer('npm', 'npm', String.raw`npx|bunx|pnpx|(?:pnpm|yarn)\s+dlx|npm\s+(?:exec|x)|bun\s+x`, 'run'),
  installer('npm', 'npm', String.raw`(?:npm|yarn|pnpm|bun)\s+create|npm\s+init`, 'create'),
  installer('pip', 'pip', String.raw`pip(?:\d+(?:\.\d+)*)?(?:\.exe)?\s+(?:-\S+\s+){0,6}install`),
  installer('pip', 'pip', String.raw`pipenv\s+install|poetry\s+add|pdm\s+add`),
  installer('pip', 'pipx', String.raw`pipx\s+install`),
  installer('pip', 'uv', String.raw`uv\s+add|uv\s+tool\s+install`),
  installer('pip', 'pipx', String.raw`pipx\s+run`, 'run'),
  installer('pip', 'uv', String.raw`uvx|uv\s+tool\s+run`, 'run'),
  installer('pip', 'uv', String.raw`uv\s+run`, 'flagged'),
];

const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;
const PIP_NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const MAX_NAME = 256; // npm caps names at 214, so anything longer is not one

const JS_VALUE_FLAGS = [
  '--registry', '--tag', '--cache', '--prefix', '--filter', '-F', '--workspace', '--cwd', '--dir', '-C', '--loglevel',
  '--userconfig', '--save-prefix', '--otp', '--omit', '--include', '--location', '--network-timeout', '--mutex',
];
const PIP_VALUE_FLAGS = [
  '-r', '--requirement', '-e', '--editable', '-c', '--constraint', '-i', '--index-url', '--extra-index-url',
  '-f', '--find-links', '-t', '--target', '--trusted-host', '--prefix', '--root', '--src', '--proxy', '--cert',
  '--client-cert', '--timeout', '--retries', '--python-version', '--python', '--platform', '--abi',
  '--implementation', '--no-binary', '--only-binary', '--upgrade-strategy', '--cache-dir', '--log', '--progress-bar',
  '--config-settings', '-C', '--global-option', '--hash', '--group', '-G', '-dG', '--source', '--extras', '-E', '--index',
  '--use-feature', '--use-deprecated', '--exists-action', '--report', '--extra',
];
// Flags that consume the next token, so that token is not a package. A letter
// can mean different things per tool: `-f` is a boolean in npm and pipx and takes
// a value in pip, and `-w` takes a value in npm and is a boolean in pnpm.
const VALUE_FLAGS = {
  npm: new Set([...JS_VALUE_FLAGS, '-w']),
  yarn: new Set(JS_VALUE_FLAGS),
  pnpm: new Set(JS_VALUE_FLAGS),
  bun: new Set(JS_VALUE_FLAGS),
  pip: new Set(PIP_VALUE_FLAGS),
  uv: new Set([...PIP_VALUE_FLAGS, '-p']),
  pipx: new Set(['--python', '--index-url', '-i', '--pip-args', '--suffix']),
};
const RUN_PACKAGE_FLAGS = new Set(['-p', '--package', '--from']);

// Exact matches only. A prefix rule like `my-` would hand squatters a namespace.
const PLACEHOLDERS = new Set([
  'package', 'packages', 'pkg', 'package-name', 'package_name', 'packagename', 'name', 'module-name', 'module_name',
  'library-name', 'library_name', 'example-package', 'example_package', 'some-package', 'some_package',
  'my-package', 'my_package', 'my-package-name', 'your-package', 'your_package', 'your-package-name',
]);
const PLACEHOLDER_SCOPED = /^@(?:your|my|some|example|scope)[-_]?(?:org|scope|company|name)?\/(?:your|my|some|example)?[-_]?(?:package|pkg|lib|library|module)(?:[-_]name)?$/i;

// A command's arguments can be read as English. In plain text and comments, one
// of these stops the reading, so "npm install evil-pkg to add it" keeps
// `evil-pkg`, until a conjunction picks it up again, so "numpy, pandas and evil"
// keeps all three. In code they only cancel a line that starts as a sentence.
const PROSE = new Set([
  'a', 'an', 'the', 'to', 'and', 'or', 'then', 'first', 'with', 'without', 'for', 'from', 'in', 'on', 'of', 'at', 'by',
  'into', 'inside', 'if', 'so', 'as', 'is', 'are', 'be', 'it', 'its', 'this', 'that', 'these', 'those', 'them', 'your',
  'you', 'we', 'our', 'all', 'any', 'each', 'both', 'some', 'instead', 'also', 'again', 'before', 'after', 'when',
  'while', 'using', 'via', 'locally', 'globally', 'manually', 'offline', 'properly', 'correctly', 'successfully',
  'usually', 'always', 'never', 'command', 'commands', 'dependency', 'dependencies', 'package', 'packages', 'library',
  'libraries', 'module', 'modules', 'requirements', 'instructions', 'guide', 'failed', 'fails', 'worked', 'works',
  'hangs', 'runs', 'finishes', 'completes', 'uses', 'everything', 'error', 'errors', 'will', 'should', 'can', 'may', 'might', 'must', 'not', 'no', 'only', 'just', 'do',
  'does', 'get', 'rest', 'here', 'below', 'above', 'later', 'import', 'use',
]);
const CONJUNCTIONS = new Set(['and', 'or', 'then', 'plus']);
const word = (token) => token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
const isProse = (token) => PROSE.has(word(token));

// Text before an installer that still leaves a comment reading as a command.
const COMMAND_LEAD = /^(?:\$\s*|sudo\s*|python[\d.]*\s+-m\s*|py\s+-m\s*|uv\s*)*$/i;
const REDIRECT = /^(?:\d*>>?|&>>?|<)/;
const DETACHED_REDIRECT = /^(?:\d*>>?|&>>?|<)$/;
const CONTINUATION = /(?:\\|\s[`^])\s*$/;

export function normalize(eco, name) {
  return eco === 'pip' ? name.toLowerCase().replace(/[-_.]+/g, '-') : name;
}

// Splits markdown into fenced blocks and everything else. One-line triple
// backticks are not fences, and treating them as one would swallow the real
// fence after them.
export function parseBlocks(text) {
  const blocks = [];
  const rest = [];
  let open = null;
  for (const line of text.split(/\r?\n/)) {
    const fence = line.match(/^\s*(?:>\s*)*(`{3,}|~{3,})(.*)$/);
    if (open) {
      const closes = fence && fence[1][0] === open.char && fence[1].length >= open.length && !fence[2].trim();
      if (closes) {
        blocks.push({ info: open.info, body: open.body.join('\n') });
        open = null;
      } else {
        open.body.push(line);
      }
    } else if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      open = { char: fence[1][0], length: fence[1].length, info: fence[2].trim(), body: [] };
    } else {
      rest.push(line);
    }
  }
  if (open) blocks.push({ info: open.info, body: open.body.join('\n') });
  return { blocks, rest };
}

// Pairs each run of backticks with the next run of the same length.
function inlineSpans(line) {
  const runs = [...line.matchAll(/`+/g)];
  const spans = [];
  let plain = '';
  let position = 0;
  for (let i = 0; i < runs.length; i++) {
    const close = runs.findIndex((run, j) => j > i && run[0].length === runs[i][0].length);
    if (close === -1) continue;
    plain += `${line.slice(position, runs[i].index)} `;
    spans.push(line.slice(runs[i].index + runs[i][0].length, runs[close].index));
    position = runs[close].index + runs[close][0].length;
    i = close;
  }
  return { spans, plain: plain + line.slice(position) };
}

function startsWithInstaller(line) {
  return INSTALLERS.some(({ re }) => line.match(re)?.index === 0);
}

// Joins shell line continuations: backslash, PowerShell backtick and cmd caret.
// A comment never continues, or a comment that ends in a backtick would swallow
// the install on the next line.
function logicalLines(lines) {
  const joined = [];
  let pending = '';
  for (const line of lines) {
    if (!/^\s*(?:#|\/\/)/.test(line) && CONTINUATION.test(line)) {
      pending += `${line.replace(CONTINUATION, '')} `;
    } else {
      joined.push(pending + line);
      pending = '';
    }
  }
  if (pending) joined.push(pending);
  return joined;
}

// Sorts what isn't in a fence into definite code and plain text.
function looseSegments(lines) {
  const code = [];
  const plain = [];
  for (const line of logicalLines(lines)) {
    const inline = inlineSpans(line);
    code.push(...inline.spans);
    const quoted = inline.plain.match(/^\s*>\s*(.*)$/);
    if (quoted) {
      (startsWithInstaller(quoted[1]) ? code : plain).push(quoted[1]);
    } else if (/^\s*(?:\(\S+\)\s*)?(?:PS\s+)?(?:[a-z]:\\[^>]*>|\S*[$%])\s+\S/i.test(inline.plain)) {
      code.push(inline.plain);
    } else if (/^(?: {4}|\t)/.test(inline.plain) && startsWithInstaller(inline.plain.trim())) {
      code.push(inline.plain);
    } else {
      plain.push(inline.plain);
    }
  }
  return { code, plain };
}

function cleanToken(eco, raw) {
  if (raw.length > MAX_NAME) return null;
  let token = raw.replace(/^['"(*[{]+/, '').replace(/['",;:).*`?!\]}]+$/, '');
  if (!token) return null;

  if (eco === 'npm') {
    if (/\.(?:tgz|tar\.gz|tar)$/i.test(token)) return null; // npm reads these as local files
    token = token.match(/^(?:@[^/]+\/)?[^@]+@npm:(.+)$/)?.[1] ?? token; // an alias installs its target
    token = token.replace(/(?<=.)@[^/]*$/, '');
    if (!NPM_NAME.test(token)) return null; // also rejects owner/repo, URLs and paths
  } else {
    if (/\.(?:whl|tar\.gz|tar\.bz2|tgz|zip)$/i.test(token)) return null;
    token = token.replace(/\[.*$/, '').replace(/[=<>~!;].*$/, '').trim();
    if (!PIP_NAME.test(token)) return null;
  }
  return PLACEHOLDERS.has(token.toLowerCase()) || PLACEHOLDER_SCOPED.test(token) ? null : token;
}

// `--with` adds to what a runner fetches. `--package` and `--from` name it instead
// of the first argument, which is then a command, not a package.
function namesFromCommand({ eco, tool, mode }, rest, careful, resume) {
  const tokens = rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const positional = [];
  const named = [];
  const extra = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const attached = mode !== 'install' && token.match(/^--(?:package|from)=(.+)$/);
    const attachedWith = mode !== 'install' && token.match(/^--with=(.+)$/);
    if (REDIRECT.test(token)) {
      if (DETACHED_REDIRECT.test(token)) i++; // the next token is its target
    } else if (attached) {
      named.push(attached[1]);
    } else if (attachedWith) {
      extra.push(attachedWith[1]);
    } else if (mode !== 'install' && token === '--with') {
      if (i + 1 < tokens.length) extra.push(tokens[++i]);
    } else if (mode !== 'install' && RUN_PACKAGE_FLAGS.has(token)) {
      if (i + 1 < tokens.length) named.push(tokens[++i]);
    } else if (VALUE_FLAGS[tool].has(token)) {
      i++;
    } else if (!token.startsWith('-')) {
      positional.push(token);
    }
  }
  let wanted = positional;
  if (careful) {
    let reading = true;
    wanted = positional.filter((token) => {
      if (resume && CONJUNCTIONS.has(word(token))) reading = true;
      else if (isProse(token)) reading = false;
      else return reading;
      return false;
    });
  } else if (wanted.length > 0 && isProse(wanted[0]) && wanted.filter(isProse).length >= 2) {
    return [];
  }
  if (mode === 'flagged') wanted = extra;
  else if (mode !== 'install') wanted = [...extra, ...(named.length > 0 ? named : wanted.slice(0, 1))];
  const names = wanted.map((token) => cleanToken(eco, token)).filter(Boolean);
  return mode === 'create' ? names.map(createPackage) : names;
}

// `npm create vite` fetches `create-vite`, and `@acme/thing` `@acme/create-thing`.
const createPackage = (name) => name.replace(/^(@[^/]+\/)?(.*)$/, '$1create-$2');

// Every installer on a line, each owning the text up to the next one, so `a and
// npm install b` and `pip install a. Then pip install b.` both yield two commands.
function installersIn(command) {
  const found = INSTALLERS.flatMap((entry) => [...command.matchAll(entry.all)].map((match) => ({ entry, match })));
  found.sort((a, b) => a.match.index - b.match.index);
  // A runner's name is also a package: `pip install uvx`, `npm i -g npx`. After
  // another installer it only starts a command if the text says a new one begins.
  const hits = found.filter(({ entry, match }, index) => index === 0 || entry.mode === 'install'
    || /(?:\b(?:and|or|then)|[.,:])\s*$/i.test(command.slice(0, match.index)));
  return hits.map(({ entry, match }, index) => {
    const end = hits[index + 1]?.match.index ?? command.length;
    return { entry, match, rest: command.slice(match.index + match[0].length, end) };
  });
}

// "Pip install x" opens a sentence and "NPM INSTALL x" is shouted, and both are
// commands. "NPM Install Guide" and "with npm I usually" are not.
function readsAsCommand(text) {
  const words = text.replace(/^[^a-z0-9]+/i, '').split(/\s+/);
  const verb = words.at(-1);
  return verb === verb.toLowerCase() || (words[0] === words[0].toUpperCase() && verb === verb.toUpperCase());
}

// `careful` is for plain text and comments, where a sentence about installing
// is likely. The census only reads a comment that opens with the command, and
// `check` also reads `# Install with: pip install x`, which is how a model often
// opens an example.
function commandsIn(segment, careful, emit, loose = false) {
  for (const rawLine of logicalLines(segment.split('\n'))) {
    // Models often write `# pip install redis` above their example, and that
    // is an instruction. `# run npm install first` is a sentence, so a comment
    // only counts when the command is the first thing in it.
    const comment = rawLine.match(/^\s*(?:#|\/\/)\s*(.*)$/);
    // `["pip", "install", "x"]` is how Python and Dockerfiles spell a command.
    const line = (comment ? comment[1] : rawLine).replace(/(["'])\s*,\s*\1/g, ' ');
    const strict = careful || Boolean(comment);
    for (const piece of line.split(/&&|\|\||[|;]|\s#/)) {
      const command = piece.trim();
      for (const { entry, match, rest } of installersIn(command)) {
        if (comment && !loose && !COMMAND_LEAD.test(command.slice(0, match.index))) continue;
        if (strict && !readsAsCommand(match[0])) continue;
        for (const name of namesFromCommand(entry, rest, strict, loose)) emit(entry.eco, name);
      }
    }
  }
}

export function extract(text, { bare = false } = {}) {
  const found = new Map();
  const emit = (eco, name) => {
    const key = `${eco}:${normalize(eco, name)}`;
    if (!found.has(key)) found.set(key, { eco, name: normalize(eco, name), raw: name });
  };
  const source = bare ? text.replace(/<\/?(?:pre|code)\b[^>]*>/gi, '') : text;
  const { blocks, rest } = parseBlocks(source);
  const { code, plain } = looseSegments(rest);
  for (const { body } of blocks) commandsIn(body, false, emit, bare);
  for (const segment of code) commandsIn(segment, false, emit, bare);
  if (bare) for (const line of plain) commandsIn(line, true, emit, bare);
  return [...found.values()];
}
