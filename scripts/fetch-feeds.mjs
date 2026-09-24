// 每日抓取 sources.json 裡啟用的 RSS，輸出 news.js 供收集平台讀取。
// 零套件相依，只用 Node 20 內建的 fetch，降低日後維護成本。
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_DAYS = 14;        // 只保留近 14 天，超過的每次執行都會被丟掉，檔案不會無限長大
const TIMEOUT_MS = 20000;
const CONCURRENCY = 6;

// 瀏覽器標頭是必要的：不少站台（Cloudflare 後面的）會直接擋掉沒有 UA 的請求
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8',
};

const unCdata = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // 必須最後處理，否則會把 &amp;lt; 解成 <
}

const clean = (s) =>
  decodeEntities(unCdata(String(s || '')).replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

const pick = (block, tags) => {
  for (const tag of tags) {
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    if (m) return m[1];
  }
  return '';
};

function pickLink(block) {
  // Atom：<link rel="alternate" href="…"/>，優先取 alternate
  const atomLinks = [...block.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi)];
  if (atomLinks.length) {
    const alt = atomLinks.find((m) => /rel=["']alternate["']/i.test(m[0]) || !/rel=/i.test(m[0]));
    if (alt) return clean(alt[1]);
    return clean(atomLinks[0][1]);
  }
  // RSS / RDF：<link>https://…</link>
  const rss = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  if (rss && clean(rss[1])) return clean(rss[1]);
  // 最後退回 guid（部分來源只給 guid 當永久連結）
  const guid = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
  if (guid && /^https?:\/\//i.test(clean(guid[1]))) return clean(guid[1]);
  return '';
}

// 去掉追蹤參數，讓同一篇文章在不同來源/不同天都能被判定成同一筆
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref|source)/i.test(k)) u.searchParams.delete(k);
    }
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function toIso(raw) {
  const s = clean(raw);
  if (!s) return null;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  return null;
}

function parseFeed(xml) {
  const blocks = [
    ...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...String(xml).matchAll(/<entry\b[\s\S]*?<\/entry>/gi),
  ].map((m) => m[0]);

  const out = [];
  for (const b of blocks) {
    const title = clean(pick(b, ['title']));
    const url = pickLink(b);
    if (!title || !url) continue;
    const summary = clean(pick(b, ['description', 'summary', 'content:encoded', 'content'])).slice(0, 300);
    const date = toIso(pick(b, ['pubDate', 'published', 'updated', 'dc:date']));
    out.push({ title, url, summary, date });
  }
  return out;
}

async function fetchFeed(src) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(src.feed, { headers: HEADERS, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, items: [] };
    const xml = await res.text();
    let items = parseFeed(xml);
    if (!items.length) return { ok: false, error: '解析不到文章', items: [] };
    // 全站型 feed（例如 Semafor）用 match 關鍵字挑出媒體產業相關的文章，
    // 否則幾百篇無關新聞會把同分級的其他來源洗掉
    if (src.match) {
      const re = new RegExp(src.match, 'i');
      items = items.filter((it) => re.test(`${it.title} ${it.summary} ${it.url}`));
    }
    // exclude 則相反，把標題含有這些字的文章擋掉（鉅亨網的盤前、速報、個股這類盤面快訊）。
    // 只比對標題，不看摘要：正文提到「個股」的正常報導不該被誤殺。
    // 同時符合 match 和 exclude 時以 exclude 為準。
    if (src.exclude) {
      const re = new RegExp(src.exclude, 'i');
      items = items.filter((it) => !re.test(it.title));
    }
    return { ok: true, error: null, items };
  } catch (err) {
    const msg = err.name === 'AbortError' ? '逾時' : String(err.message || err);
    return { ok: false, error: msg, items: [] };
  } finally {
    clearTimeout(timer);
  }
}

// 併發上限，避免一次打太多站台
async function mapLimit(list, limit, fn) {
  const results = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      results[idx] = await fn(list[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function loadPrevious() {
  // 沿用上一份資料：某個來源今天臨時掛掉時，既有文章不會整批消失
  try {
    const js = await readFile(join(ROOT, 'news.js'), 'utf8');
    const start = js.indexOf('{');
    const end = js.lastIndexOf('}');
    if (start === -1 || end === -1) return { items: [] };
    return JSON.parse(js.slice(start, end + 1));
  } catch {
    return { items: [] };
  }
}

async function main() {
  const cfg = JSON.parse(await readFile(join(ROOT, 'sources.json'), 'utf8'));
  const enabled = cfg.sources.filter((s) => s.enabled && s.feed);
  console.log(`抓取 ${enabled.length} 個來源…`);

  const fetched = await mapLimit(enabled, CONCURRENCY, async (src) => {
    const r = await fetchFeed(src);
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${src.name} ${r.ok ? r.items.length + ' 篇' : r.error}`);
    return { src, ...r };
  });

  const now = new Date();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86400000);

  const previous = await loadPrevious();
  const byId = new Map();
  for (const it of previous.items || []) byId.set(it.id, it);

  for (const { src, items } of fetched) {
    for (const raw of items) {
      const url = normalizeUrl(raw.url);
      const id = hashId(url);
      const existing = byId.get(id);
      byId.set(id, {
        id,
        title: raw.title,
        url,
        summary: raw.summary,
        date: raw.date,
        // 沒有發布時間的來源，用第一次抓到的時間當排序依據
        firstSeen: existing ? existing.firstSeen : nowIso,
        source: src.name,
        tier: src.tier,
        lang: src.lang,
        site: src.site,
      });
    }
  }

  const items = [...byId.values()]
    .filter((it) => new Date(it.date || it.firstSeen) >= cutoff)
    .sort((a, b) => new Date(b.date || b.firstSeen) - new Date(a.date || a.firstSeen));

  const payload = {
    generatedAt: nowIso,
    keepDays: KEEP_DAYS,
    sources: fetched.map(({ src, ok, error, items }) => ({
      name: src.name, tier: src.tier, lang: src.lang, feed: src.feed,
      ok, error, count: items.length,
    })),
    disabled: cfg.sources.filter((s) => !s.enabled).map((s) => ({ name: s.name, tier: s.tier, note: s.note })),
    // 蒐集台的「來源管理」面板在讀不到 sources.json 時（例如把檔案存到本機直接開）
    // 會退回用這份，才能產生完整的設定檔內容
    allSources: cfg.sources,
    items,
  };

  // 寫成 .js 而不是 .json：用 <script> 載入不受 CORS 限制，
  // 直接把檔案存到桌面點兩下打開也能正常運作
  const js = `window.NEWS_DATA = ${JSON.stringify(payload, null, 1)};\n`;
  await writeFile(join(ROOT, 'news.js'), js, 'utf8');

  const failed = payload.sources.filter((s) => !s.ok);
  console.log(`\n完成：${items.length} 篇文章，來源成功 ${payload.sources.length - failed.length}/${payload.sources.length}`);
  if (failed.length) console.log('失敗來源：' + failed.map((s) => `${s.name}(${s.error})`).join('、'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
