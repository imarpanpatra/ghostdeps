// Decides what a package name actually is, from the registry's own evidence.
//
//   alive      real, published, and not obviously brand new
//   ghost      the registry has no such name, and deps.dev has no memory of it
//   possessed  a real package now holds the name, but it is new and barely
//              used, or the census saw this name as a ghost and it exists now.
//              This says the name is occupied. It says nothing about intent.
//   dead       real, but deprecated by its own maintainer
//   tombstone  the package existed and was unpublished or fully yanked
//   exorcised  npm replaced it with a security holding package
//   unknown    the registry did not give a usable answer
//
// `unknown` is load-bearing. A 429 or a timeout is not evidence that a package
// exists, and it is not evidence that it doesn't, so it must never collapse
// into alive or ghost.

export const STATES = ['alive', 'ghost', 'possessed', 'dead', 'tombstone', 'exorcised', 'unknown'];

const DAY = 86_400_000;
export const YOUNG_DAYS = 365;
export const FEW_DOWNLOADS = 500;
export const FEW_RELEASES = 3;

const isYoung = (createdAt, now) => createdAt !== null && now - createdAt < YOUNG_DAYS * DAY;

async function getJson(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (response.status === 404) return { status: 404 };
    if (!response.ok) return { status: response.status };
    return { status: 200, body: await response.json() };
  } catch (error) {
    return { status: 0, error: error.message };
  }
}

// A registry 404 means "not here now", and a package taken down for policy
// reasons can look the same. deps.dev keeps its own record, so it gets a say: if
// it remembers versions, the name once lived. If it can't be reached, the 404
// still stands, but the verdict says it went unconfirmed.
async function confirmGhost(fetchImpl, system, name) {
  const record = await getJson(fetchImpl, `https://api.deps.dev/v3/systems/${system}/packages/${encodeURIComponent(name)}`);
  if (record.status === 200 && record.body.versions?.length) {
    return { state: 'tombstone', detail: 'gone from the registry, but deps.dev remembers it' };
  }
  return { state: 'ghost', corroborated: record.status === 404 };
}

async function classifyNpm(name, { fetchImpl, now }) {
  const encoded = name.replace('/', '%2f');
  const doc = await getJson(fetchImpl, `https://registry.npmjs.org/${encoded}`);
  if (doc.status === 404) return confirmGhost(fetchImpl, 'npm', name);
  if (doc.status !== 200) return { state: 'unknown', detail: `npm answered ${doc.status}` };

  const { time = {}, versions = {}, description = '' } = doc.body;
  const createdAt = time.created ? Date.parse(time.created) : null;
  const created = time.created?.slice(0, 10) ?? null;

  if (time.unpublished) return { state: 'tombstone', created, detail: `unpublished ${String(time.unpublished.time).slice(0, 10)}` };

  const latest = doc.body['dist-tags']?.latest;
  if (latest === undefined || !versions[latest]) return { state: 'unknown', created, detail: 'no latest version in the document' };
  if (/-security(?:\.\d+)?$/.test(latest) && /security holding/i.test(`${description} ${doc.body.readme ?? ''}`)) {
    return { state: 'exorcised', created };
  }
  const healthy = () => {
    const { deprecated } = versions[latest];
    return deprecated ? { state: 'dead', created, detail: String(deprecated).slice(0, 120) } : { state: 'alive', created };
  };

  // Age comes before deprecation: otherwise a publisher could dodge `possessed`
  // by deprecating a day-old package.
  if (!isYoung(createdAt, now)) return healthy();

  const stats = await getJson(fetchImpl, `https://api.npmjs.org/downloads/point/last-month/${name}`);
  if (stats.status !== 200) return { state: 'unknown', created, detail: `npm downloads answered ${stats.status}` };
  const downloads = stats.body.downloads ?? 0;
  return downloads < FEW_DOWNLOADS
    ? { state: 'possessed', created, downloads, detail: `first published ${created}, ${downloads} downloads last month` }
    : { ...healthy(), downloads };
}

async function classifyPip(name, { fetchImpl, now }) {
  const doc = await getJson(fetchImpl, `https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  if (doc.status === 404) return confirmGhost(fetchImpl, 'pypi', name);
  if (doc.status !== 200) return { state: 'unknown', detail: `PyPI answered ${doc.status}` };

  const releases = Object.values(doc.body.releases ?? {}).filter((files) => files.length > 0);
  const files = releases.flat();
  const uploads = files.map((file) => Date.parse(file.upload_time_iso_8601 ?? file.upload_time)).filter(Number.isFinite);
  const createdAt = uploads.length ? Math.min(...uploads) : null;
  const created = createdAt === null ? null : new Date(createdAt).toISOString().slice(0, 10);

  if (files.length === 0) return { state: 'tombstone', detail: 'project exists with no files' };
  if (files.every((file) => file.yanked)) return { state: 'tombstone', created, detail: 'every release yanked' };
  if (isYoung(createdAt, now) && releases.length <= FEW_RELEASES) {
    return { state: 'possessed', created, releases: releases.length, detail: `first published ${created}, ${releases.length} release(s)` };
  }
  return doc.body.info?.yanked ? { state: 'dead', created, detail: 'latest release yanked' } : { state: 'alive', created };
}

export function classify(eco, name, { fetchImpl = fetch, now = Date.now() } = {}) {
  return eco === 'npm' ? classifyNpm(name, { fetchImpl, now }) : classifyPip(name, { fetchImpl, now });
}

// Bounded concurrency, and a shared cache so one census asks once per name.
export async function classifyAll(items, { cache = new Map(), concurrency = 4, ...options } = {}) {
  const queue = items.filter(({ eco, name }) => !cache.has(`${eco}:${name}`));
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const verdict = await classify(item.eco, item.name, options);
      cache.set(`${item.eco}:${item.name}`, verdict);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return items.map((item) => ({ ...item, ...cache.get(`${item.eco}:${item.name}`) }));
}
