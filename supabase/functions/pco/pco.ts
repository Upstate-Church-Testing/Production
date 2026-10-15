// A small Planning Center API client: personal-access-token auth, paging,
// and staying under the rate limit (100 requests per 20 seconds).

const API = 'https://api.planningcenteronline.com';

export class PcoError extends Error {
  status: number;
  url: string;
  constructor(status: number, url: string, detail = '') {
    super(pcoMessage(status, url, detail));
    this.status = status;
    this.url = url;
  }
}

function pcoMessage(status: number, url: string, detail: string) {
  const where = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (status === 401) return 'Planning Center didn’t accept that Application ID and secret. Check them and try again.';
  if (status === 403) return `The Planning Center account that made this token can’t see ${where.includes('/people/') ? 'People' : 'everything in Services'}.`;
  if (status === 404) return `Planning Center couldn’t find ${where}.`;
  if (status === 429) return 'Planning Center is busy. Try again in a minute.';
  const text = detail.slice(0, 200);
  return `Planning Center answered ${status} for ${where}${text ? `: ${text}` : ''}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Doc = { data: any; included?: any[]; links?: { next?: string }; meta?: any };

export function pcoClient({ appId, secret, base = API, fetchImpl = fetch, perWindow = 85, windowMs = 20000 }:
  { appId: string; secret: string; base?: string; fetchImpl?: typeof fetch; perWindow?: number; windowMs?: number }) {
  const auth = 'Basic ' + btoa(`${appId}:${secret}`);
  const host = new URL(base).host;
  const stamps: number[] = [];
  let requests = 0;

  async function slot() {
    for (;;) {
      const now = Date.now();
      while (stamps.length && now - stamps[0] >= windowMs) stamps.shift();
      if (stamps.length < perWindow) { stamps.push(now); return; }
      await sleep(windowMs - (now - stamps[0]) + 25);
    }
  }

  async function get(pathOrUrl: string): Promise<Doc> {
    const url = /^https?:/.test(pathOrUrl) ? pathOrUrl : base + pathOrUrl;
    if (new URL(url).host !== host) throw new Error('Refusing to follow a link off Planning Center.');
    for (let attempt = 0; ; attempt++) {
      await slot();
      requests++;
      let res: Response;
      try {
        res = await fetchImpl(url, { headers: { Authorization: auth, Accept: 'application/json', 'User-Agent': 'Upstate Production (church app)' } });
      } catch (e) {
        if (attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
        throw new Error(`Couldn’t reach Planning Center: ${(e as Error).message}`);
      }
      if (res.status === 429 && attempt < 5) {
        const wait = Number(res.headers.get('Retry-After')) || 5;
        await res.body?.cancel();
        await sleep(Math.min(30, wait) * 1000 + 100);
        continue;
      }
      if (res.status >= 500 && attempt < 2) { await res.body?.cancel(); await sleep(1500); continue; }
      if (!res.ok) throw new PcoError(res.status, url, await res.text().catch(() => ''));
      return await res.json();
    }
  }

  /** Every page of a list, with everything `include`d gathered up. */
  async function all(path: string, maxPages = 25): Promise<{ data: any[]; included: any[] }> {
    const data: any[] = [];
    const included: any[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < maxPages; page++) {
      const doc = await get(next);
      if (Array.isArray(doc.data)) data.push(...doc.data); else if (doc.data) data.push(doc.data);
      if (doc.included) included.push(...doc.included);
      next = doc.links?.next || undefined;
    }
    return { data, included };
  }

  return { get, all, get requests() { return requests; } };
}

export type Pco = ReturnType<typeof pcoClient>;

/** The id a JSON:API relationship points at, or null. */
export const relId = (item: any, name: string): string | null => item?.relationships?.[name]?.data?.id ?? null;
export const relIds = (item: any, name: string): string[] => {
  const d = item?.relationships?.[name]?.data;
  return Array.isArray(d) ? d.map((x: any) => x.id) : d?.id ? [d.id] : [];
};
