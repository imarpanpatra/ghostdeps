// Builds docs/index.html from data/summary.json. The page is self-contained, and
// a section with no data behind it is left out rather than filled with a guess.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const SUMMARY_PATH = new URL('../data/summary.json', import.meta.url);
const DOCS_DIR = new URL('../docs/', import.meta.url);
const PAGE_PATH = new URL('../docs/index.html', import.meta.url);

const PRIMARY = 'gemma3:4b';
const GROUP_LABELS = {
  'npm/mainstream': 'npm, everyday tasks',
  'npm/niche': 'npm, niche tasks',
  'pip/mainstream': 'PyPI, everyday tasks',
  'pip/niche': 'PyPI, niche tasks',
};

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

function bars(entry) {
  const rows = Object.entries(GROUP_LABELS).map(([key, label]) => {
    const group = entry.byGroup[key];
    const rate = group.ghostNameRate ?? 0;
    const known = group.distinctNames - group.states.unknown;
    return `<div class="bar-row" title="${group.states.ghost} of ${known} distinct names">
      <span class="bar-label">${label}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(rate, 0.5)}%"></span></span>
      <span class="bar-value">${rate}%</span>
      <span class="bar-count">${group.states.ghost} of ${known}</span>
    </div>`;
  });
  return `<section>
    <h2>The less common the task, the less real the answer</h2>
    <p>Share of distinct packages with no record on the registry or in deps.dev.</p>
    <div class="bars">${rows.join('')}</div>
  </section>`;
}

function findings(entry, summary) {
  const cards = [];
  if (entry.haunt) {
    const { ghostsTracked, seeds, returnedEveryTime, returnedAtLeastOnce, averageReturns, overall } = entry.haunt;
    cards.push(['They come back', `${returnedAtLeastOnce} of ${ghostsTracked}`,
      `ghosts returned when the question was asked ${seeds} more times with new seeds, ${averageReturns} times each on average. ${returnedEveryTime} returned every time. ${overall.answersWithGhost} of those ${overall.questions} answers held a ghost, this one or another.`]);
  }
  if (entry.mirror && entry.mirrorValid) {
    const { mirror, mirrorValid } = entry;
    const correct = mirror.ghost.no + mirror.alive.yes;
    const total = mirror.ghost.total + mirror.alive.total;
    cards.push(['They can\'t tell they\'re dead', `${correct} of ${total}`,
      `right when the model was asked if its own niche answers were real, ${mirror.ghost.total} ghosts and ${mirror.alive.total} real packages. One wording called ${mirror.ghost.yes} ghosts real, another ${mirrorValid.ghost.yes}.`]);
  }
  if (entry.determinism) {
    const { sameNames, comparable, identicalText, rerun, ghostsTracked, ghostsRepeated } = entry.determinism;
    cards.push(['The name outlasts the sentence', `${sameNames} of ${comparable}`,
      `repeat runs named the same package, though only ${identicalText} of ${rerun} repeated the answer word for word. Of the ghosts in that set, ${ghostsRepeated} of ${ghostsTracked} came back.`]);
  }
  if (summary.sharedGhosts) {
    cards.push(['Two models, one ghost', String(summary.sharedGhosts),
      'names were invented by both gemma3:4b and gemma3:1b, separately, from the same questions.']);
  }
  if (summary.occupied) {
    cards.push(['Something moved in', String(summary.occupied),
      'names the model gave are held by packages under a year old with almost no use. That means a name is occupied. It does not mean anyone did anything wrong.']);
  }
  if (!cards.length) return '';
  return `<section class="cards">${cards.map(([title, figure, body]) => `<article>
    <h3>${title}</h3><p class="figure">${figure}</p><p>${body}</p></article>`).join('')}</section>`;
}

function graveyard(entry) {
  const stones = entry.topGhosts.map(({ eco, shape, runs }) => `<div class="stone" title="Seen in ${runs} answers">
    <span class="rip">never was</span>
    <code>${escapeHtml(shape)}</code>
    <span class="eco">${eco === 'pip' ? 'PyPI' : 'npm'}, seen ${runs}x</span>
  </div>`);
  return `<section>
    <h2>The graveyard</h2>
    <p>The most persistent ghosts. Names are masked because registering one is the attack: a developer who
    trusts the model installs whatever now lives at that name.</p>
    <div class="stones">${stones.join('')}</div>
  </section>`;
}

export function renderReport(summary) {
  const entry = summary.models[PRIMARY];
  if (!entry) throw new Error(`The summary has no ${PRIMARY} sweep, so there is nothing to report.`);
  const { overall } = entry;
  const known = overall.distinctNames - overall.states.unknown;
  const date = summary.generatedAt.slice(0, 10);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ghostdeps</title>
<meta name="description" content="A census of the packages that only exist inside an open-weight model.">
<style>
  :root { --ink:#16181a; --panel:#202427; --line:#343a3e; --paper:#f2f2eb; --muted:#a7ada8; --ochre:#f5b726; --stone:#2b3134; }
  * { box-sizing: border-box; }
  html { background: var(--ink); }
  body { margin: 0; color: var(--paper); background: var(--ink); font: 17px/1.6 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 56px 16px 72px; }
  header .kicker { color: var(--muted); font-size: 14px; letter-spacing: .08em; text-transform: uppercase; margin: 0; }
  h1 { font: 700 clamp(40px, 9vw, 72px)/1.05 Georgia, "Times New Roman", serif; margin: 8px 0 28px; }
  .hero { font: 700 clamp(56px, 14vw, 112px)/1 Georgia, "Times New Roman", serif; color: var(--ochre); margin: 0; }
  .lede { font-size: 20px; max-width: 34em; margin: 12px 0 0; }
  section { margin-top: 56px; }
  h2 { font: 700 26px/1.25 Georgia, "Times New Roman", serif; margin: 0 0 8px; }
  section > p { color: var(--muted); margin: 0 0 20px; max-width: 40em; }
  .bars { display: grid; gap: 10px; }
  .bar-row { display: grid; grid-template-columns: 190px 1fr 58px 76px; gap: 12px; align-items: center; }
  .bar-label { font-size: 15px; }
  .bar-track { height: 16px; background: var(--panel); border-radius: 4px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; background: var(--ochre); border-radius: 0 4px 4px 0; }
  .bar-value { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .bar-count { text-align: right; color: var(--muted); font-size: 14px; font-variant-numeric: tabular-nums; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
  .cards article { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; }
  .cards h3 { font-size: 15px; margin: 0; color: var(--muted); font-weight: 600; }
  .cards .figure { font: 700 40px/1.1 Georgia, "Times New Roman", serif; margin: 10px 0; color: var(--paper); }
  .cards article p:last-child { margin: 0; font-size: 15px; }
  .stones { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
  .stone { background: var(--stone); border-radius: 80px 80px 6px 6px; padding: 30px 12px 14px; text-align: center; display: grid; gap: 6px; }
  .stone .rip { font: italic 14px Georgia, "Times New Roman", serif; color: var(--muted); }
  .stone code { font: 600 14px ui-monospace, Consolas, monospace; overflow-wrap: anywhere; }
  .stone .eco { font-size: 12px; color: var(--muted); }
  dl { display: grid; grid-template-columns: 120px 1fr; gap: 6px 14px; margin: 0; }
  dt { font-weight: 600; }
  dd { margin: 0; color: var(--muted); }
  footer { margin-top: 56px; color: var(--muted); font-size: 14px; }
  a { color: var(--ochre); }
  @media (max-width: 620px) {
    .bar-row { grid-template-columns: 1fr 58px; }
    .bar-track { grid-column: 1 / -1; grid-row: 2; }
    .bar-count { display: none; }
    dl { grid-template-columns: 1fr; }
    dd { margin-bottom: 8px; }
  }
</style>
</head>
<body>
<main>
  <header>
    <p class="kicker">A census of the open-weight dead</p>
    <h1>ghostdeps</h1>
    <p class="hero">${overall.ghostNameRate}%</p>
    <p class="lede">of the packages ${PRIMARY} told me to install do not exist: ${overall.states.ghost} of ${known} distinct names, across ${overall.questions} ordinary developer questions.</p>
  </header>
  ${bars(entry)}
  ${findings(entry, summary)}
  ${graveyard(entry)}
  <section>
    <h2>How to read this</h2>
    <p>Every name came out of an install command in the model's own answer. The registries decided what was real.</p>
    <dl>
      <dt>Model</dt><dd>${PRIMARY}, digest <code>${entry.digest?.slice(0, 12)}</code>, running locally through Ollama.</dd>
      <dt>Ghost</dt><dd>The registry has no such name and deps.dev has no memory of it (${overall.ghostsCorroborated} of ${overall.states.ghost} confirmed by both). A deletion neither source recorded would look the same, so this means "no trace found", not "proven never to exist".</dd>
      <dt>Unanswered</dt><dd>${overall.noInstallCommand} of ${overall.questions} questions produced no install command and add no names.</dd>
      <dt>Sample</dt><dd>${overall.questions} hand-written tasks, half everyday and half niche. This describes one model on one list, not every model.</dd>
      <dt>Taken</dt><dd>${date}.</dd>
    </dl>
  </section>
  <footer>Built for the Hacktoberfest Open-Source AI Challenge, Week 4: Ghost in the Machine.</footer>
</main>
</body>
</html>
`;
}

export function writeReport() {
  const summary = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'));
  mkdirSync(DOCS_DIR, { recursive: true });
  writeFileSync(PAGE_PATH, renderReport(summary));
  return 'docs/index.html';
}
