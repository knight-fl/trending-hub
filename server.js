const express = require('express');
const { exec } = require('child_process');

const app = express();
const PORT = 3000;

// ─── Cache ───
const cache = new Map();
const CACHE_TTL = 3600_000; // 1 hour

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) return null;
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// ─── Hot score formatter ───
function formatHot(num) {
  if (num == null) return '';
  const n = Number(num);
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return n.toLocaleString();
}

// ─── Fetch helpers ───
const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

async function fetchWithTimeout(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Bilibili ───
function generateBuvid3() {
  const hex = () => Math.random().toString(16).slice(2, 6);
  return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}infoc`;
}

async function fetchBilibili() {
  const buvid3 = generateBuvid3();
  const url = 'https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1';
  const res = await fetchWithTimeout(url, {
    headers: {
      ...COMMON_HEADERS,
      Referer: 'https://www.bilibili.com',
      Cookie: `buvid3=${buvid3}; b_nut=${Math.floor(Date.now() / 1000)};`,
    },
  });
  if (!res.ok) throw new Error(`Bilibili HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(`Bilibili API error: ${json.message}`);

  const list = json.data.list;
  return list.map((item, index) => ({
    id: item.bvid,
    rank: index + 1,
    title: decodeHTMLEntities(item.title),
    hot: formatHot(item.stat.view),
    url: `https://www.bilibili.com/video/${item.bvid}`,
    author: item.owner.name,
  }));
}

// ─── Weibo ───
async function fetchWeibo() {
  const url = 'https://weibo.com/ajax/side/hotSearch';
  const res = await fetchWithTimeout(url, {
    headers: { ...COMMON_HEADERS, Referer: 'https://weibo.com' },
  });
  if (!res.ok) throw new Error(`Weibo HTTP ${res.status}`);
  const json = await res.json();

  const realtime = json.data?.realtime;
  if (!realtime || !Array.isArray(realtime)) throw new Error('Weibo: unexpected response format');

  return realtime.map((item, index) => ({
    id: item.word,
    rank: index + 1,
    title: item.word,
    hot: formatHot(item.num || item.raw_hot),
    url: `https://s.weibo.com/weibo?q=${encodeURIComponent(item.word)}`,
    author: item.label_name || '',
  }));
}

// ─── Douyin ───
async function fetchDouyin() {
  // Step 1: get CSRF cookie
  const cookieRes = await fetchWithTimeout(
    'https://www.douyin.com/passport/general/login_guiding_strategy/?aid=6383',
    { headers: { ...COMMON_HEADERS, Referer: 'https://www.douyin.com' } }
  );
  const setCookie = cookieRes.headers.get('set-cookie') || '';
  const tokenMatch = setCookie.match(/passport_csrf_token=([^;]+)/);
  const csrfToken = tokenMatch ? tokenMatch[1] : '';

  // Step 2: fetch hot list
  const dataUrl =
    'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1';
  const dataRes = await fetchWithTimeout(dataUrl, {
    headers: {
      ...COMMON_HEADERS,
      Referer: 'https://www.douyin.com',
      Cookie: csrfToken ? `passport_csrf_token=${csrfToken}` : '',
    },
  });
  if (!dataRes.ok) throw new Error(`Douyin HTTP ${dataRes.status}`);
  const json = await dataRes.json();

  const wordList = json.data?.word_list;
  if (!wordList || !Array.isArray(wordList)) throw new Error('Douyin: unexpected response format');

  return wordList.map((item, index) => ({
    id: item.sentence_id || item.hot_value,
    rank: index + 1,
    title: item.word,
    hot: formatHot(item.hot_value),
    url: item.group_id
      ? `https://www.douyin.com/video/${item.group_id}`
      : `https://www.douyin.com/hot/${item.sentence_id}`,
    author: '',
    pic: (item.word_cover && item.word_cover.url_list && item.word_cover.url_list[0]) || '',
    video_count: item.video_count || 0,
  }));
}

// ─── Life/Meme (生活玩梗) ───

/* Fetch recent Bilibili trending content from popular endpoint.
   Filters to last 72h for freshness. */
async function fetchBilibiliLifeRecent() {
  const buvid3 = generateBuvid3();
  const headers = {
    ...COMMON_HEADERS,
    Referer: 'https://www.bilibili.com',
    Cookie: `buvid3=${buvid3}; b_nut=${Math.floor(Date.now() / 1000)};`,
  };
  const MAX_AGE = 259200; // 72 hours in seconds

  const all = [];
  for (let page = 1; page <= 2; page++) {
    try {
      const url = `https://api.bilibili.com/x/web-interface/popular?ps=50&pn=${page}`;
      const res = await fetchWithTimeout(url, { headers });
      if (!res.ok) continue;
      const json = await res.json();
      if (json.code !== 0) continue;
      for (const item of json.data.list) {
        if ((Date.now() / 1000) - item.pubdate > MAX_AGE) continue;
        all.push(item);
      }
    } catch (_) {}
  }

  return all.map((item, idx) => ({
    id: item.bvid,
    rank: idx + 1,
    title: decodeHTMLEntities(item.title),
    hot: formatHot(item.stat.view),
    url: `https://www.bilibili.com/video/${item.bvid}`,
    author: item.owner.name,
    pic: item.pic ? item.pic.replace(/^http:/, 'https:') : '',
    desc: item.desc ? decodeHTMLEntities(item.desc).slice(0, 80) : '',
    danmaku: formatHot(item.stat.danmaku),
    duration: item.duration,
  })).slice(0, 30);
}

async function fetchLifeMeme() {
  const [bilibili, douyin] = await Promise.allSettled([
    fetchBilibiliLifeRecent(),
    fetchDouyin(),
  ]);

  return {
    bilibili: bilibili.status === 'fulfilled' ? bilibili.value : [],
    douyin: douyin.status === 'fulfilled' ? douyin.value : [],
    lastUpdate: Date.now(),
  };
}

// ─── YouTube GCC ───

/* Fetch YouTube trending for a country via HTML scraping (most reliable).
   Extracts ytInitialData JSON from trending page. */
const ytTrendingCache = {};
async function fetchYoutubeTrending(gl) {
  const errors = [];

  // ── Method 1: Direct HTML scrape (with DoH to bypass DNS blocking) ──
  try {
    const htmlRes = await fetchWithDoH(`https://www.youtube.com/feed/trending?gl=${gl}`, {
      headers: {
        ...COMMON_HEADERS,
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }, 'www.youtube.com');
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      const match = html.match(/var ytInitialData\s*=\s*({.*?});<\/script>/);
      if (match) {
        const data = JSON.parse(match[1]);
        const items = extractYouTubeVideos(data);
        if (items.length > 0) {
          console.log(`[yt-${gl}] scraped ${items.length} items`);
          return items;
        }
        errors.push('scrape: 0 items extracted');
      } else {
        errors.push('scrape: ytInitialData not found (len=' + html.length + ')');
      }
    } else {
      errors.push('scrape: HTTP ' + htmlRes.status);
    }
  } catch (e) {
    errors.push('scrape: ' + e.message);
  }

  // ── Method 2: Invidious instances (with DoH) ──
  const instances = ['https://inv.nadeko.net', 'https://yewtu.be', 'https://invidious.lunar.icu'];
  for (const base of instances) {
    try {
      const urlObj = new URL(base);
      const res = await fetchWithDoH(`${base}/api/v1/trending?region=${gl}`, {
        headers: { ...COMMON_HEADERS },
      }, urlObj.hostname);
      if (!res.ok) { errors.push(`invidious ${base}: HTTP ${res.status}`); continue; }
      const json = await res.json();
      if (!Array.isArray(json) || !json.length) { errors.push(`invidious ${base}: empty`); continue; }

      const items = json.slice(0, 30).map((v, idx) => ({
        id: v.videoId || '', rank: idx + 1,
        title: v.title || '',
        hot: formatHot(v.viewCount || 0),
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
        author: v.author || '',
        pic: (v.videoThumbnails?.[0]?.url || '').replace(/^http:/, 'https:'),
        desc: '',
        duration: v.lengthSeconds || 0,
      }));
      console.log(`[yt-${gl}] invidious ${base}: ${items.length} items`);
      return items;
    } catch (e) {
      errors.push(`invidious ${base}: ` + e.message);
    }
  }

  console.error(`[yt-${gl}] ALL FAILED:`, errors.join(' | '));
  return [];
}

/* Auto-detect Windows system proxy once at startup. */
let _systemProxy = null;
function getSystemProxy() {
  if (_systemProxy !== null) return _systemProxy;
  try {
    const { execSync } = require('child_process');
    const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer 2>nul', { encoding: 'utf8', timeout: 3000 });
    const m = out.match(/ProxyServer\s+REG_SZ\s+(.+)/);
    if (m && m[1]) {
      const addr = m[1].trim();
      _systemProxy = addr.includes('://') ? addr : `http://${addr}`;
      return _systemProxy;
    }
  } catch (_) {}
  _systemProxy = false;
  return null;
}

/* Check if a proxy is configured (for display/logging only —
   we use DoH + direct connection, NOT the system proxy). */
function setupProxy() {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY ||
                process.env.https_proxy || process.env.http_proxy ||
                getSystemProxy();
  if (proxy) {
    // Do NOT set global HTTPS_PROXY — it breaks DoH requests.
    // We use direct DoH + IP connection instead.
    console.log('  检测到代理: ' + proxy + ' (GCC请求走DoH直连)');
  }
}

/* Fetch for restricted networks: DoH + direct IP connection.
   Bypasses both DNS blocking and non-HTTP proxies. */
async function fetchWithDoH(url, options = {}, realHostname) {
  const urlObj = new URL(url);
  const host = realHostname || urlObj.hostname;
  const https = require('https');

  // Try multiple DoH providers (Google may be blocked in some regions)
  let dohIP = null;
  for (const dohUrl of [
    'https://cloudflare-dns.com/dns-query',
    'https://dns.google/resolve',
    'https://doh.pub/dns-query',
  ]) {
    try {
      const dr = await fetchWithTimeout(`${dohUrl}?name=${encodeURIComponent(host)}&type=A`, {
        headers: { Accept: 'application/dns-json' },
      }, 5000);
      if (!dr.ok) continue;
      const j = await dr.json();
      const ips = (j.Answer || []).filter(a => a.type === 1).map(a => a.data);
      if (ips.length) {
        dohIP = ips[Math.floor(Math.random() * ips.length)];
        break;
      }
    } catch (_) {}
  }

  return new Promise((resolve, reject) => {
    const fetchOptions = {
      hostname: dohIP || urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      servername: host,
      rejectUnauthorized: !!dohIP ? false : true,
      headers: { ...(options.headers || {}), Host: host },
      timeout: 15000,
    };
    const req = https.request(fetchOptions, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 400,
          status: res.statusCode,
          headers: { get: (name) => res.headers[name.toLowerCase()] },
          text: () => Promise.resolve(Buffer.concat(chunks).toString()),
          json: () => Promise.resolve(JSON.parse(Buffer.concat(chunks).toString())),
        });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

/* Recursively search ytInitialData for videoRenderer objects. */
function extractYouTubeVideos(data) {
  const videos = [];
  const seen = new Set();

  function walk(obj) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
    seen.add(obj);
    if (Array.isArray(obj)) { obj.forEach(walk); return; }

    for (const key of Object.keys(obj)) {
      if (key === 'videoRenderer' && obj[key] && typeof obj[key] === 'object') {
        const v = obj[key];
        const videoId = v.videoId || '';
        if (videoId && !videos.find(x => x.id === videoId)) {
          videos.push({
            id: videoId,
            title: v.title?.runs?.[0]?.text || v.title?.simpleText || '',
            hot: formatHot(parseInt(v.viewCountText?.simpleText?.replace(/[^0-9]/g, '') || v.viewCountText?.runs?.[0]?.text?.replace(/[^0-9]/g, '') || '0', 10) || 0),
            url: `https://www.youtube.com/watch?v=${videoId}`,
            author: v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || '',
            pic: ((v.thumbnail?.thumbnails || [])[0]?.url || '').replace(/^http:/, 'https:'),
            desc: '',
            duration: 0,
          });
        }
      }
      if (typeof obj[key] === 'object') walk(obj[key]);
    }
  }

  walk(data);
  return videos.slice(0, 30).map((v, i) => ({ ...v, rank: i + 1 }));
}

/* Lazy-init Innertube session (fallback, not bundled in pkg). */
let ytSession = null;
async function getYouTubeSession() {
  if (ytSession) return ytSession;
  try {
    const { Innertube } = require('youtubei.js');
    ytSession = await Innertube.create({ lang: 'en', location: 'SA', retrieve_player: false });
  } catch (_) {}
  return ytSession;
}

/* Fetch YouTube trending for GCC countries (SA + AE), merge results. */
async function fetchYoutubeGCC() {
  const results = await Promise.allSettled([
    fetchYoutubeTrending('SA'),
    fetchYoutubeTrending('AE'),
  ]);
  return {
    sa: results[0].status === 'fulfilled' ? results[0].value : [],
    ae: results[1].status === 'fulfilled' ? results[1].value : [],
    lastUpdate: Date.now(),
  };
}

/* Filter YouTube GCC results for life/entertainment content. */
async function fetchYoutubeGCCLife() {
  const data = await fetchYoutubeGCC();
  const LIFE_CATS = new Set(['Music', 'Entertainment', 'Comedy', 'People & Blogs', 'Howto & Style']);
  return {
    sa: data.sa.filter(v => !v.category || LIFE_CATS.has(v.category)).slice(0, 20),
    ae: data.ae.filter(v => !v.category || LIFE_CATS.has(v.category)).slice(0, 20),
    lastUpdate: data.lastUpdate,
  };
}

// ─── TikTok GCC ───

/* Fetch TikTok trending for GCC region.
   Tries multiple approaches since TikTok API changes frequently. */
async function fetchTiktokGCC() {
  const errors = [];

  // ── Method 1: Douyin-style cookie + api/trending (with DoH) ──
  try {
    const cookieRes = await fetchWithDoH('https://www.tiktok.com/', {
      headers: {
        ...COMMON_HEADERS,
        Referer: 'https://www.tiktok.com/',
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
    }, 'www.tiktok.com');
    const setCookie = cookieRes.headers.get('set-cookie') || '';

    // Try API endpoints (TikTok has several)
    const endpoints = [
      `https://www.tiktok.com/api/trending/item_list/?aid=1988&app_language=en&app_name=tiktok_web&device_platform=web&region=SA&count=30`,
      `https://www.tiktok.com/api/recommend/item_list/?aid=1988&app_language=en&app_name=tiktok_web&device_platform=web&region=SA&count=30&is_encryption=0`,
      `https://www.tiktok.com/api/explore/item_list/?aid=1988&app_language=en&app_name=tiktok_web&device_platform=web&region=SA&count=30`,
    ];

    for (const url of endpoints) {
      try {
        const res = await fetchWithDoH(url, {
          headers: { ...COMMON_HEADERS, Referer: 'https://www.tiktok.com/', Cookie: setCookie },
        }, 'www.tiktok.com');
        if (!res.ok) { errors.push(`tiktok ${url.split('?')[0].split('/').pop()}: HTTP ${res.status}`); continue; }
        const json = await res.json();

        // TikTok returns different structures for different endpoints
        let rawItems = json?.itemList || json?.items || json?.aweme_list || [];
        if (!rawItems.length && json?.data) rawItems = json.data;

        if (Array.isArray(rawItems) && rawItems.length > 0) {
          const items = rawItems.slice(0, 30).map((item, idx) => {
            const author = item.author || item.authorStats || {};
            const stats = item.stats || item.statistics || {};
            const video = item.video || {};
            return {
              id: item.id || item.aweme_id || '',
              rank: idx + 1,
              title: item.desc || item.title || '',
              hot: formatHot(stats.playCount || stats.diggCount || stats.play_count || 0),
              url: item.id
                ? `https://www.tiktok.com/@${author.uniqueId || 'user'}/video/${item.id}`
                : '#',
              author: author.nickname || author.uniqueId || '',
              pic: (video.cover?.url_list?.[0] || video.originCover?.url_list?.[0] || item.cover || '').replace(/^http:/, 'https:'),
              video_count: 0,
            };
          });
          console.log(`[tiktok-gcc] ${items.length} items`);
          return items;
        }
        errors.push('tiktok: empty response');
      } catch (e) {
        errors.push('tiktok api: ' + e.message);
      }
    }
  } catch (e) {
    errors.push('tiktok cookie: ' + e.message);
  }

  console.error('[tiktok-gcc] ALL FAILED:', errors.join(' | '));
  return [];
}

// ─── HTML entity decoder ───
function decodeHTMLEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—');
}

// ─── Route factory ───
function createRoute(platform, fetcher) {
  return async (req, res) => {
    const noCache = req.query.noCache === '1';
    if (!noCache) {
      const cached = getCache(platform);
      if (cached) {
        return res.json({ success: true, platform, lastUpdate: cached.timestamp, items: cached.items });
      }
    }
    try {
      const items = await fetcher();
      const entry = { timestamp: Date.now(), items };
      setCache(platform, entry);
      res.json({ success: true, platform, lastUpdate: entry.timestamp, items });
    } catch (err) {
      console.error(`[${platform}]`, err.message);
      const stale = cache.get(platform);
      if (stale) {
        return res.json({
          success: true,
          platform,
          lastUpdate: stale.timestamp,
          items: stale.items,
          stale: true,
        });
      }
      res.json({ success: false, platform, error: err.message });
    }
  };
}

// ─── API Routes ───
app.get('/api/bilibili', createRoute('bilibili', fetchBilibili));
app.get('/api/weibo', createRoute('weibo', fetchWeibo));
app.get('/api/douyin', createRoute('douyin', fetchDouyin));
app.get('/api/lifememe', createRoute('lifememe', fetchLifeMeme));

// ─── GCC Routes ───
async function fetchGccTop() {
  const [yt, tk] = await Promise.allSettled([fetchYoutubeGCC(), fetchTiktokGCC()]);
  return {
    youtube: yt.status === 'fulfilled' ? yt.value : { sa: [], ae: [], lastUpdate: Date.now() },
    tiktok: tk.status === 'fulfilled' ? tk.value : [],
    lastUpdate: Date.now(),
  };
}
async function fetchGccLife() {
  const [yt, tk] = await Promise.allSettled([fetchYoutubeGCCLife(), fetchTiktokGCC()]);
  return {
    youtube: yt.status === 'fulfilled' ? yt.value : { sa: [], ae: [], lastUpdate: Date.now() },
    tiktok: tk.status === 'fulfilled' ? tk.value : [],
    lastUpdate: Date.now(),
  };
}
app.get('/api/gcctop', createRoute('gcctop', fetchGccTop));
app.get('/api/gcclife', createRoute('gcclife', fetchGccLife));

// Hard timeout wrapper: rejects after ms even if underlying op hangs
function hardTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`HARD TIMEOUT ${label}`)), ms)),
  ]);
}

// Proxy diagnostics — tests all code paths
app.get('/api/proxy-test', async (req, res) => {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || getSystemProxy() || 'none';
  const out = { proxy, tests: {} };

  // Test 1: system DNS resolution
  const dns = require('dns').promises;
  try { const r = await dns.resolve4('www.youtube.com'); out.tests.dns_yt = r[0]; } catch(e) { out.tests.dns_yt = e.code; }
  try { const r = await dns.resolve4('dns.google'); out.tests.dns_doh = r[0]; } catch(e) { out.tests.dns_doh = e.code; }
  try { const r = await dns.resolve4('www.tiktok.com'); out.tests.dns_tt = r[0]; } catch(e) { out.tests.dns_tt = e.code; }

  // Test 2: DoH resolution (Cloudflare → Google → DNSPod)
  out.tests.doh_yt = { status: 'testing' };
  for (const doh of ['cloudflare-dns.com', 'dns.google', 'doh.pub']) {
    try {
      const dr = await fetchWithTimeout(`https://${doh}/dns-query?name=www.youtube.com&type=A`, { headers: { Accept:'application/dns-json' } }, 5000);
      if (!dr.ok) { out.tests.doh_yt[doh] = 'HTTP '+dr.status; continue; }
      const j = await dr.json();
      const ips = (j.Answer||[]).filter(a=>a.type===1).map(a=>a.data);
      out.tests.doh_yt[doh] = ips.length ? ips[0] : 'no A records';
    } catch(e) { out.tests.doh_yt[doh] = e.message; }
  }

  // Test 3: DoH-based fetch to YouTube (full path)
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const fr = await fetchWithDoH('https://www.youtube.com/', {}, 'www.youtube.com');
    clearTimeout(t);
    out.tests.doh_fetch_yt = fr.ok ? ('HTTP '+fr.status) : ('bad status '+fr.status);
  } catch(e) { out.tests.doh_fetch_yt = e.message; }

  res.json(out);
});

/* ─── SOCKS5 tunnel (no dependencies, ~40 lines) ─── */
function socks5Connect(proxyHost, proxyPort, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const socket = net.connect({ host: proxyHost, port: proxyPort }, () => {
      // Step 1: greeting
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    let step = 0, buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (step === 0 && buf.length >= 2) {
        if (buf[0] !== 0x05 || buf[1] !== 0x00) { socket.destroy(); return reject(new Error('SOCKS5 auth failed')); }
        // Step 2: connect to target
        const hostBytes = Buffer.from(targetHost, 'utf8');
        const portBytes = Buffer.alloc(2);
        portBytes.writeUInt16BE(targetPort, 0);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]), hostBytes, portBytes]));
        buf = Buffer.alloc(0); step = 1;
      } else if (step === 1 && buf.length >= 10) {
        if (buf[1] !== 0x00) { socket.destroy(); return reject(new Error('SOCKS5 connect failed: ' + buf[1])); }
        resolve(socket);
      }
    });
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); reject(new Error('SOCKS5 timeout')); }, 10000);
  });
}

/* HTTPS request through SOCKS5 proxy */
function httpsViaSocks5(hostname, path, headers) {
  return new Promise(async (resolve, reject) => {
    try {
      const socket = await socks5Connect('127.0.0.1', 29758, hostname, 443);
      const tls = require('tls');
      const tlsSocket = tls.connect({ socket, servername: hostname, rejectUnauthorized: false }, () => {
        tlsSocket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\n${Object.entries(headers||{}).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      });
      let data = '';
      tlsSocket.on('data', c => { data += c.toString(); });
      tlsSocket.on('end', () => {
        const headerEnd = data.indexOf('\r\n\r\n');
        if (headerEnd < 0) return reject(new Error('no headers'));
        const body = data.slice(headerEnd + 4);
        resolve({ ok: data.includes('200 OK'), json: () => Promise.resolve(JSON.parse(body)) });
      });
      tlsSocket.on('error', reject);
      setTimeout(() => { tlsSocket.destroy(); reject(new Error('TLS timeout')); }, 12000);
    } catch (e) { reject(e); }
  });
}

// GCC proxy — reads pre-fetched JSON from GitHub Actions
const GCC_DATA_BASE = process.env.GCC_DATA_REPO ||
  'https://raw.githubusercontent.com/knight-fl/trending-hub/main/data';

app.get('/api/inv-proxy', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=1800');
  const region = req.query.region || 'SA';

  try {
    // Map: top tab fetches gcc-top.json, life tab not used via this endpoint
    const file = 'gcc-top.json';
    const url = `${GCC_DATA_BASE}/${file}?_=${Date.now()}`;
    const r = await fetchWithTimeout(url, { headers: { ...COMMON_HEADERS } }, 10000);
    if (!r.ok) return res.json([]);
    const data = await r.json();

    // Return appropriate region's data
    if (region === 'SA') return res.json(data.youtube_sa || []);
    if (region === 'AE') return res.json(data.youtube_ae || []);
    res.json([]);
  } catch (_) {
    res.json([]);
  }
});

// GCC life endpoint — same pattern
app.get('/api/inv-proxy-life', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=1800');
  try {
    const url = `${GCC_DATA_BASE}/gcc-life.json?_=${Date.now()}`;
    const r = await fetchWithTimeout(url, { headers: { ...COMMON_HEADERS } }, 10000);
    if (!r.ok) return res.json({ youtube_sa: [], youtube_ae: [] });
    res.json(await r.json());
  } catch (_) {
    res.json({ youtube_sa: [], youtube_ae: [] });
  }
});

// Debug endpoint: returns raw fetcher results + errors
app.get('/api/gcc-debug', async (req, res) => {
  const gl = req.query.gl || 'SA';

  let ytResult, tkResult;
  try {
    ytResult = await hardTimeout((async () => {
      const t0 = Date.now();
      const items = await fetchYoutubeTrending(gl);
      return { region: gl, count: items.length, ms: Date.now() - t0, sample: items[0] || null };
    })(), 15000, 'yt-debug');
  } catch (e) { ytResult = { count: 0, ms: 0, error: e.message }; }

  try {
    tkResult = await hardTimeout((async () => {
      const t0 = Date.now();
      const items = await fetchTiktokGCC();
      return { count: items.length, ms: Date.now() - t0, sample: items[0] || null };
    })(), 15000, 'tk-debug');
  } catch (e) { tkResult = { count: 0, ms: 0, error: e.message }; }

  res.json({
    youtube: ytResult,
    tiktok: tkResult,
    note: 'If count=0 check /api/proxy-test first to diagnose connectivity.',
  });
});

// ─── Inline static assets ───

const STYLE_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { font-size: 15px; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  background: #f0f2f5;
  color: #1a1a1a;
  min-height: 100vh;
}
header {
  background: #fff;
  padding: 16px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 1px 4px rgba(0,0,0,.08);
  position: sticky;
  top: 0;
  z-index: 10;
}
header h1 {
  font-size: 1.35rem;
  font-weight: 700;
  background: linear-gradient(135deg, #fb7299, #ff8200, #00a8ff);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.header-controls { display: flex; align-items: center; gap: 16px; }
.refresh-time { font-size: .85rem; color: #888; white-space: nowrap; }
#refreshBtn {
  padding: 6px 16px; border: none; border-radius: 20px;
  background: #1a1a1a; color: #fff; font-size: .85rem; cursor: pointer; transition: opacity .2s;
}
#refreshBtn:hover { opacity: .8; }
#refreshBtn:disabled { opacity: .4; cursor: not-allowed; }
.grid {
  display: grid; grid-template-columns: 1fr 1fr 1fr;
  gap: 16px; padding: 16px 24px; max-width: 1600px; margin: 0 auto;
}
@media (max-width: 1024px) { .grid { grid-template-columns: 1fr 1fr; } }
@media (max-width: 640px) { .grid { grid-template-columns: 1fr; padding: 12px; } header { padding: 12px 16px; } header h1 { font-size: 1.1rem; } }
.column {
  background: #fff; border-radius: 12px; overflow: hidden;
  box-shadow: 0 1px 4px rgba(0,0,0,.06); display: flex; flex-direction: column;
  max-height: calc(100vh - 90px);
}
.column-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; border-bottom: 3px solid var(--accent); flex-shrink: 0;
}
.column-header h2 { font-size: 1rem; font-weight: 600; }
.count { font-size: .8rem; color: #888; background: #f5f5f5; padding: 2px 10px; border-radius: 10px; }
.item-list { list-style: none; overflow-y: auto; flex: 1; }
.item-list li {
  display: flex; align-items: center; padding: 10px 16px; gap: 10px;
  border-bottom: 1px solid #f0f0f0; transition: background .15s;
}
.item-list li:hover { background: #f8f9fa; }
.rank {
  width: 22px; height: 22px; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-size: .75rem; font-weight: 700; flex-shrink: 0; background: #e8e8e8; color: #666;
}
.rank.top1 { background: #fb7299; color: #fff; }
.rank.top2 { background: #ff8200; color: #fff; }
.rank.top3 { background: #00a8ff; color: #fff; }
.item-title {
  flex: 1; min-width: 0; font-size: .88rem; color: #1a1a1a;
  text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.item-title:hover { color: var(--accent, #1a80e8); }
.item-hot { font-size: .78rem; color: #999; white-space: nowrap; flex-shrink: 0; }
.item-author {
  font-size: .75rem; color: #bbb; white-space: nowrap; flex-shrink: 0;
  max-width: 80px; overflow: hidden; text-overflow: ellipsis;
}
.error-banner {
  padding: 12px 16px; background: #fff0f0; color: #d32f2f; font-size: .85rem;
  display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;
}
.error-banner button {
  border: 1px solid #d32f2f; background: #fff; color: #d32f2f;
  border-radius: 14px; padding: 3px 12px; font-size: .8rem; cursor: pointer;
}
.error-banner button:hover { background: #d32f2f; color: #fff; }
.stale-badge { font-size: .7rem; color: #e67e22; background: #fef3e0; padding: 1px 6px; border-radius: 4px; margin-left: 6px; }
.skeleton { pointer-events: none; }
.skeleton-line {
  height: 14px; border-radius: 8px;
  background: linear-gradient(90deg, #eee 25%, #f5f5f5 50%, #eee 75%);
  background-size: 200% 100%; animation: shimmer 1.5s infinite; width: 100%;
}
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.stale-warning { font-size: .7rem; color: #e67e22; margin-left: 8px; }

#section-lifememe { height: calc(100vh - 90px); overflow: hidden; }
#section-gcctop { height: calc(100vh - 90px); overflow: hidden; }
#section-gcclife { height: calc(100vh - 90px); overflow: hidden; }
#section-hot { min-height: calc(100vh - 90px); }

/* ─── Tabs ─── */
.tabs { display: flex; gap: 4px; }
.tab-btn {
  padding: 6px 18px; border: none; border-radius: 8px;
  font-size: .88rem; cursor: pointer; background: #e8e8e8; color: #666;
  transition: all .2s;
}
.tab-btn.active { background: #1a1a1a; color: #fff; }
.tab-btn:hover:not(.active) { background: #d5d5d5; }

/* ─── Life/Meme Cards ─── */
.lm-col-list {
  overflow-y: auto; flex: 1; min-height: 0;
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 16px;
}
.lm-card {
  display: block; width: 100%; flex-shrink: 0;
  background: #fff;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0,0,0,.06);
  cursor: pointer;
  transition: transform .15s, box-shadow .15s;
  text-decoration: none; color: inherit;
}
.lm-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,.1); }
.lm-card-pic {
  width: 100%; aspect-ratio: 16/9; object-fit: cover;
  background: #f0f0f0;
}
.lm-card-pic-placeholder {
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  font-size: 2rem;
}
.lm-card-body { padding: 12px 14px; }
.lm-card-title {
  font-size: .9rem; font-weight: 600; color: #1a1a1a;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  overflow: hidden; line-height: 1.4; margin-bottom: 6px;
}
.lm-card-meta {
  display: flex; align-items: center; gap: 12px;
  font-size: .75rem; color: #999;
}
.lm-card-author { color: #666; font-weight: 500; }
.lm-card-desc {
  font-size: .78rem; color: #888; margin-top: 6px;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  overflow: hidden; line-height: 1.5;
}
.lm-card-duration {
  position: absolute; bottom: 8px; right: 8px;
  background: rgba(0,0,0,.7); color: #fff; font-size: .7rem;
  padding: 2px 6px; border-radius: 4px;
}
.lm-pic-wrap { position: relative; }
.lm-rank-badge {
  position: absolute; top: 8px; left: 8px;
  width: 24px; height: 24px; border-radius: 6px;
  background: rgba(0,0,0,.6); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: .7rem; font-weight: 700;
}
.lm-rank-badge.r1 { background: #fb7299; }
.lm-rank-badge.r2 { background: #ff8200; }
.lm-rank-badge.r3 { background: #00a8ff; }
.lm-section-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 24px; max-width: 1600px; margin: 12px auto 4px;
}
.lm-section-header h2 { font-size: .95rem; color: #666; }
.lm-col-refresh-btn {
  border: none; background: none; font-size: .85rem; color: #888;
  cursor: pointer; padding: 2px 6px; border-radius: 4px;
}
.lm-col-refresh-btn:hover { background: #eee; color: #333; }
.lm-col-refresh-btn:disabled { opacity: .4; cursor: not-allowed; }

@media (max-width: 640px) {
  .tab-btn { padding: 4px 14px; font-size: .82rem; }
}
`;

const APP_JS = `
const state={platforms:['bilibili','weibo','douyin'],lastRefresh:null,timer:null};
const PLATFORM={bilibili:{label:'B站',accent:'#fb7299'},weibo:{label:'微博',accent:'#ff8200'},douyin:{label:'抖音',accent:'#00a8ff'}};
async function fetchPlatform(p,nc){const u='/api/'+p+(nc?'?noCache=1':'');const r=await fetch(u);return r.json();}
function renderPlatform(p,d){
  const l=document.getElementById('list-'+p),e=document.getElementById('error-'+p),c=document.getElementById('count-'+p);
  e.style.display='none';
  if(!d.success){l.innerHTML='';c.textContent='0';e.style.display='flex';e.innerHTML='<span>'+(d.error||'获取失败')+'</span><button onclick="refreshOne(\\''+p+'\\')">重试</button>';return;}
  const h=document.querySelector('.column[data-platform="'+p+'"] .column-header');
  let sb=h.querySelector('.stale-warning');
  if(d.stale){if(!sb){sb=document.createElement('span');sb.className='stale-warning';sb.textContent='⚠ 数据可能延迟';h.appendChild(sb);}}else if(sb)sb.remove();
  c.textContent=d.items.length;
  l.innerHTML=d.items.map(function(i){
    var rc=i.rank===1?'top1':i.rank===2?'top2':i.rank===3?'top3':'';
    var ah=i.author?'<span class="item-author">'+eh(i.author)+'</span>':'';
    return '<li><span class="rank '+rc+'">'+i.rank+'</span><a class="item-title" href="'+i.url+'" target="_blank" rel="noopener" style="--accent:'+PLATFORM[p].accent+'">'+eh(i.title)+'</a>'+ah+'<span class="item-hot">'+i.hot+'</span></li>';
  }).join('');
}
function renderError(p,m){const l=document.getElementById('list-'+p),e=document.getElementById('error-'+p),c=document.getElementById('count-'+p);l.innerHTML='';c.textContent='0';e.style.display='flex';e.innerHTML='<span>'+m+'</span><button onclick="refreshOne(\\''+p+'\\')">重试</button>';}
async function refreshAll(nc){
  var b=document.getElementById('refreshBtn');b.disabled=true;b.textContent='⟳ 刷新中...';
  try{
    var r=await Promise.allSettled(state.platforms.map(function(p){return fetchPlatform(p,nc);}));
    r.forEach(function(rr,i){var p=state.platforms[i];if(rr.status==='fulfilled')renderPlatform(p,rr.value);else renderError(p,'网络请求失败');});
    state.lastRefresh=Date.now();updateLastRefreshTime();
  }finally{b.disabled=false;b.textContent='⟳ 刷新全部';}
}
async function refreshOne(p){var d=await fetchPlatform(p,true);renderPlatform(p,d);state.lastRefresh=Date.now();updateLastRefreshTime();}
function startAutoRefresh(){refreshAll(false);state.timer=setInterval(function(){if(state.lastRefresh&&(Date.now()-state.lastRefresh>=3600000))refreshAll(false);},60000);}
function updateLastRefreshTime(){var e=document.getElementById('lastRefresh');if(state.lastRefresh){var d=new Date(state.lastRefresh);var z=function(n){return String(n).padStart(2,'0');};e.textContent='上次更新：'+z(d.getHours())+':'+z(d.getMinutes())+':'+z(d.getSeconds());}}
function eh(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}
window.addEventListener('load',startAutoRefresh);

/* ─── Life/Meme tab ─── */
function refreshLifeMeme(){
  var bbl=document.getElementById('grid-lmbilibili'),bdy=document.getElementById('grid-lmdouyin');
  // Show loading skeletons
  if(!bbl.children.length||bbl.querySelector('.skeleton-line')){setLmSkeleton('lmbilibili');}
  if(!bdy.children.length||bdy.querySelector('.skeleton-line')){setLmSkeleton('lmdouyin');}
  fetch('/api/lifememe?noCache=1').then(function(r){return r.json();}).then(function(d){
    if(d.success){renderLifeBilibili(d.items.bilibili||[]);renderLifeDouyin(d.items.douyin||[]);updateLmTime(Date.now());}
    else{showLmColError('lmbilibili',d.error||'获取失败');showLmColError('lmdouyin',d.error||'获取失败');}
  }).catch(function(e){showLmColError('lmbilibili','网络请求失败');showLmColError('lmdouyin','网络请求失败');});
}
function refreshLifeBilibili(){
  setLmSkeleton('lmbilibili');
  fetch('/api/lifememe?noCache=1').then(function(r){return r.json();}).then(function(d){
    if(d.success)renderLifeBilibili(d.items.bilibili||[]);
    else showLmColError('lmbilibili',d.error||'获取失败');
  }).catch(function(){showLmColError('lmbilibili','网络请求失败');});
}
function refreshLifeDouyin(){
  setLmSkeleton('lmdouyin');
  fetch('/api/lifememe?noCache=1').then(function(r){return r.json();}).then(function(d){
    if(d.success)renderLifeDouyin(d.items.douyin||[]);
    else showLmColError('lmdouyin',d.error||'获取失败');
  }).catch(function(){showLmColError('lmdouyin','网络请求失败');});
}
function setLmSkeleton(p){
  var g=document.getElementById('grid-'+p),e=document.getElementById('error-'+p);
  e.style.display='none';g.style.display='';
  g.innerHTML=Array(6).join('<div class="lm-card"><div class="lm-pic-wrap"><div class="skeleton-line" style="width:100%;aspect-ratio:16/9"></div></div><div class="lm-card-body"><div class="skeleton-line" style="width:80%"></div><div class="skeleton-line" style="width:50%;margin-top:6px"></div></div></div>');
}
function renderLifeBilibili(items){
  var g=document.getElementById('grid-lmbilibili'),e=document.getElementById('error-lmbilibili'),c=document.getElementById('count-lmbilibili');
  e.style.display='none';g.style.display='';c.textContent=items.length;
  g.innerHTML=items.map(function(i){
    var rc=i.rank===1?'r1':i.rank===2?'r2':i.rank===3?'r3':'';
    var ds=i.desc?'<div class="lm-card-desc">'+eh(i.desc)+'</div>':'';
    var dr='';if(i.duration){var m=Math.floor(i.duration/60),s=String(i.duration%60).padStart(2,'0');dr='<span class="lm-card-duration">'+m+':'+s+'</span>';}
    var pic=i.pic?'<img class="lm-card-pic" src="'+i.pic+'" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\\'none\\'">':'<div class="lm-card-pic lm-card-pic-placeholder"><span>📺</span></div>';
    return '<a class="lm-card" href="'+i.url+'" target="_blank" rel="noopener">'+
      '<div class="lm-pic-wrap">'+pic+dr+'<span class="lm-rank-badge '+rc+'">'+i.rank+'</span></div>'+
      '<div class="lm-card-body"><div class="lm-card-title">'+eh(i.title)+'</div>'+
      '<div class="lm-card-meta"><span class="lm-card-author">'+eh(i.author)+'</span><span>▶ '+i.hot+'</span><span>弹幕 '+i.danmaku+'</span></div>'+ds+'</div></a>';
  }).join('');
}
function renderLifeDouyin(items){
  var g=document.getElementById('grid-lmdouyin'),e=document.getElementById('error-lmdouyin'),c=document.getElementById('count-lmdouyin');
  e.style.display='none';g.style.display='';c.textContent=items.length;
  g.innerHTML=items.map(function(i){
    var rc=i.rank===1?'r1':i.rank===2?'r2':i.rank===3?'r3':'';
    var vc=i.video_count?'<span>📹 '+i.video_count+'个视频</span>':'';
    var pic=i.pic?'<img class="lm-card-pic" src="'+i.pic+'" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\\'none\\'">':'<div class="lm-card-pic lm-card-pic-placeholder"><span>🎵</span></div>';
    return '<a class="lm-card" href="'+i.url+'" target="_blank" rel="noopener">'+
      '<div class="lm-pic-wrap">'+pic+'<span class="lm-rank-badge '+rc+'">'+i.rank+'</span></div>'+
      '<div class="lm-card-body"><div class="lm-card-title">'+eh(i.title)+'</div>'+
      '<div class="lm-card-meta">'+vc+'<span>🔥 '+i.hot+'</span></div></div></a>';
  }).join('');
}
function showLmColError(p,msg){
  var g=document.getElementById('grid-'+p),e=document.getElementById('error-'+p),c=document.getElementById('count-'+p);
  g.innerHTML='';c.textContent='0';e.style.display='flex';e.innerHTML='<span>'+msg+'</span><button onclick="refreshLife'+(p==='lmbilibili'?'Bilibili':'Douyin')+'()">重试</button>';
}
function updateLmTime(ts){
  var el=document.getElementById('lmTime');
  if(ts){var d=new Date(ts),z=function(n){return String(n).padStart(2,'0');};el.textContent='更新 '+z(d.getHours())+':'+z(d.getMinutes())+':'+z(d.getSeconds());}
}

/* ─── GCC tabs (browser-side fetch via Invidious) ─── */
function switchTab(tab){
  ['hot','lifememe','gcctop','gcclife'].forEach(function(t){
    var s=document.getElementById(t==='hot'?'section-hot':t==='lifememe'?'section-lifememe':'section-'+t);
    if(s)s.style.display=t===tab?'':'none';
  });
  document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.toggle('active',b.dataset.tab===tab);});
  if(tab==='lifememe')refreshLifeMeme();
  if(tab==='gcctop'||tab==='gcclife')refreshGccTab(tab);
}
function fmtNum(n){if(!n)return '0';if(n>=1e8)return (n/1e8).toFixed(1)+'亿';if(n>=1e4)return (n/1e4).toFixed(1)+'万';return n.toLocaleString();}
async function fetchInvidious(region){
  try{var r=await fetch('/api/inv-proxy?region='+region+'&_='+Date.now(),{signal:AbortSignal.timeout(35000),cache:'no-cache'});if(!r.ok)return[];var j=await r.json();return Array.isArray(j)?j:[];}catch(e){return[];}
}
var GCC_RAW = 'https://raw.githubusercontent.com/knight-fl/trending-hub/refs/heads/main/data';

function refreshGccTab(tab){
  if(tab==='gcctop'){
    ['ytsa','ytae','tkgcc'].forEach(function(c){setGccSkeleton(c);});
    fetch(GCC_RAW+'/gcc-top.json?_='+Date.now(),{cache:'no-cache'}).then(r=>r.json()).then(function(d){
      renderGccColBrowser('ytsa',(d.youtube_sa||[]).slice(0,30));
      renderGccColBrowser('ytae',(d.youtube_ae||[]).slice(0,30));
      renderGccColBrowser('tkgcc',[]);
      updateGccTime('gccTime',Date.now());
    }).catch(function(e){console.error(e);});
  }else{
    ['glytsa','glytae'].forEach(function(c){setGccSkeleton(c);});
    fetch(GCC_RAW+'/gcc-life.json?_='+Date.now(),{cache:'no-cache'}).then(r=>r.json()).then(function(d){
      renderGccColBrowser('glytsa',(d.youtube_sa||[]).slice(0,20));
      renderGccColBrowser('glytae',(d.youtube_ae||[]).slice(0,20));
      updateGccTime('gccLifeTime',Date.now());
    }).catch(function(e){console.error(e);});
  }
}
function refreshGccCol(col){
  setGccSkeleton(col);
  if(col==='tkgcc'){renderGccColBrowser('tkgcc',[]);return;}
  fetch(GCC_RAW+'/gcc-top.json?_='+Date.now(),{cache:'no-cache'}).then(r=>r.json()).then(function(d){
    var items = col==='ytsa'||col==='glytsa' ? (d.youtube_sa||[]) : (d.youtube_ae||[]);
    renderGccColBrowser(col, items.slice(0,30));
  }).catch(function(e){console.error(e);showGccColError(col,'请求失败');});
}
function renderGccColBrowser(col,items){
  var g=document.getElementById('grid-'+col),e=document.getElementById('error-'+col),c=document.getElementById('count-'+col);
  e.style.display='none';g.style.display='';c.textContent=items.length;
  if(!items.length){g.innerHTML='<div style="text-align:center;padding:20px;color:#999">无数据</div>';return;}
  g.innerHTML=items.slice(0,30).map(function(v,idx){
    var rc=idx<3?'r'+(idx+1):'';
    var pic=v.thumb||'';
    return '<a class="lm-card" href="https://www.youtube.com/watch?v='+v.videoId+'" target="_blank" rel="noopener">'+
      '<div class="lm-pic-wrap">'+(pic?'<img class="lm-card-pic" src="'+pic+'" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\\'none\\'">':'<div class="lm-card-pic lm-card-pic-placeholder"><span>📺</span></div>')+
      '<span class="lm-rank-badge '+rc+'">'+(idx+1)+'</span></div>'+
      '<div class="lm-card-body"><div class="lm-card-title">'+eh(v.title||'')+'</div>'+
      '<div class="lm-card-meta"><span class="lm-card-author">'+eh(v.author||'')+'</span><span>▶ '+fmtNum(v.viewCount||0)+'</span></div></div></a>';
  }).join('');
}
function setGccSkeleton(col){
  var g=document.getElementById('grid-'+col),e=document.getElementById('error-'+col);
  e.style.display='none';g.style.display='';
  g.innerHTML=Array(6).join('<div class="lm-card"><div class="lm-pic-wrap"><div class="skeleton-line" style="width:100%;aspect-ratio:16/9"></div></div><div class="lm-card-body"><div class="skeleton-line" style="width:80%"></div></div></div>');
}
function showGccColError(col,msg){
  var g=document.getElementById('grid-'+col),e=document.getElementById('error-'+col),c=document.getElementById('count-'+col);
  g.innerHTML='';c.textContent='0';e.style.display='flex';e.innerHTML='<span>'+msg+'</span><button onclick="refreshGccCol(\\''+col+'\\')">重试</button>';
}
function updateGccTime(id,ts){
  var el=document.getElementById(id);
  if(ts){var d=new Date(ts),z=function(n){return String(n).padStart(2,'0');};el.textContent='更新 '+z(d.getHours())+':'+z(d.getMinutes())+':'+z(d.getSeconds());}
}`;

const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>热点聚合</title>
  <style>${STYLE_CSS}</style>
</head>
<body>
  <header>
    <h1>热点聚合</h1>
    <nav class="tabs">
      <button class="tab-btn active" data-tab="hot" onclick="switchTab('hot')">总榜</button>
      <button class="tab-btn" data-tab="lifememe" onclick="switchTab('lifememe')">生活玩梗</button>
      <button class="tab-btn" data-tab="gcctop" onclick="switchTab('gcctop')">GCC总榜</button>
      <button class="tab-btn" data-tab="gcclife" onclick="switchTab('gcclife')">GCC生活</button>
    </nav>
    <div class="header-controls">
      <span class="refresh-time" id="lastRefresh">上次更新：--</span>
      <button id="refreshBtn" onclick="refreshAll(true)">⟳ 刷新全部</button>
    </div>
  </header>

  <!-- 总榜 -->
  <div id="section-hot">
    <main class="grid">
      <section class="column" data-platform="bilibili">
        <div class="column-header" style="--accent: #fb7299">
          <h2>B站 热门</h2><span class="count" id="count-bilibili">0</span>
        </div>
        <ol class="item-list" id="list-bilibili">${'<li class="skeleton"><div class="skeleton-line"></div></li>'.repeat(10)}</ol>
        <div class="error-banner" id="error-bilibili" style="display:none"></div>
      </section>
      <section class="column" data-platform="weibo">
        <div class="column-header" style="--accent: #ff8200">
          <h2>微博 热搜</h2><span class="count" id="count-weibo">0</span>
        </div>
        <ol class="item-list" id="list-weibo">${'<li class="skeleton"><div class="skeleton-line"></div></li>'.repeat(10)}</ol>
        <div class="error-banner" id="error-weibo" style="display:none"></div>
      </section>
      <section class="column" data-platform="douyin">
        <div class="column-header" style="--accent: #00a8ff">
          <h2>抖音 热点</h2><span class="count" id="count-douyin">0</span>
        </div>
        <ol class="item-list" id="list-douyin">${'<li class="skeleton"><div class="skeleton-line"></div></li>'.repeat(10)}</ol>
        <div class="error-banner" id="error-douyin" style="display:none"></div>
      </section>
    </main>
  </div>

  <!-- 生活玩梗 -->
  <div id="section-lifememe" style="display:none">
    <div class="lm-section-header">
      <h2>生活共鸣 · 真人玩梗</h2>
      <span class="refresh-time" id="lmTime" style="font-size:.75rem">--</span>
    </div>
    <main class="grid">
      <section class="column" data-platform="lmbilibili">
        <div class="column-header" style="--accent: #fb7299">
          <h2>B站 生活</h2>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="count" id="count-lmbilibili">0</span>
            <button class="lm-col-refresh-btn" onclick="refreshLifeBilibili()" title="刷新B站">⟳</button>
          </div>
        </div>
        <div class="lm-col-list" id="grid-lmbilibili">
          ${'<div class="lm-card"><div class="lm-pic-wrap"><div class="skeleton-line" style="width:100%;aspect-ratio:16/9"></div></div><div class="lm-card-body"><div class="skeleton-line" style="width:80%"></div><div class="skeleton-line" style="width:50%;margin-top:6px"></div></div></div>'.repeat(6)}
        </div>
        <div class="error-banner" id="error-lmbilibili" style="display:none"></div>
      </section>
      <section class="column" data-platform="lmdouyin">
        <div class="column-header" style="--accent: #00a8ff">
          <h2>抖音 生活</h2>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="count" id="count-lmdouyin">0</span>
            <button class="lm-col-refresh-btn" onclick="refreshLifeDouyin()" title="刷新抖音">⟳</button>
          </div>
        </div>
        <div class="lm-col-list" id="grid-lmdouyin">
          ${'<div class="lm-card"><div class="lm-pic-wrap"><div class="skeleton-line" style="width:100%;aspect-ratio:16/9"></div></div><div class="lm-card-body"><div class="skeleton-line" style="width:80%"></div><div class="skeleton-line" style="width:50%;margin-top:6px"></div></div></div>'.repeat(6)}
        </div>
        <div class="error-banner" id="error-lmdouyin" style="display:none"></div>
      </section>
    </main>
  </div>

  <!-- GCC 总榜 -->
  <div id="section-gcctop" style="display:none">
    <div class="lm-section-header">
      <h2>GCC 海湾热榜</h2>
      <span class="refresh-time" id="gccTime" style="font-size:.75rem">--</span>
    </div>
    <main class="grid">
      <section class="column" data-platform="ytsa">
        <div class="column-header" style="--accent: #ff0000">
          <h2>YT · Saudi</h2>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="count" id="count-ytsa">0</span>
            <button class="lm-col-refresh-btn" onclick="refreshGccCol('ytsa')">⟳</button>
          </div>
        </div>
        <div class="lm-col-list" id="grid-ytsa">${'<div class="lm-card"><div class="lm-pic-wrap"><div class="skeleton-line" style="width:100%;aspect-ratio:16/9"></div></div><div class="lm-card-body"><div class="skeleton-line" style="width:80%"></div></div></div>'.repeat(6)}</div>
        <div class="error-banner" id="error-ytsa" style="display:none"></div>
      </section>
      <section class="column" data-platform="ytae">
        <div class="column-header" style="--accent: #009639">
          <h2>YT · UAE</h2>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="count" id="count-ytae">0</span>
            <button class="lm-col-refresh-btn" onclick="refreshGccCol('ytae')">⟳</button>
          </div>
        </div>
        <div class="lm-col-list" id="grid-ytae">${'<div class="lm-card"><div class="lm-pic-wrap"><div class="skeleton-line" style="width:100%;aspect-ratio:16/9"></div></div><div class="lm-card-body"><div class="skeleton-line" style="width:80%"></div></div></div>'.repeat(6)}</div>
        <div class="error-banner" id="error-ytae" style="display:none"></div>
      </section>
      <section class="column" data-platform="tkgcc">
        <div class="column-header" style="--accent: #000000">
          <h2>TikTok · GCC</h2>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="count" id="count-tkgcc">0</span>
            <button class="lm-col-refresh-btn" onclick="refreshGccCol('tkgcc')">⟳</button>
          </div>
        </div>
        <div class="lm-col-list" id="grid-tkgcc">${'<div class="lm-card"><div class="lm-pic-wrap"><div class="skeleton-line" style="width:100%;aspect-ratio:16/9"></div></div><div class="lm-card-body"><div class="skeleton-line" style="width:80%"></div></div></div>'.repeat(6)}</div>
        <div class="error-banner" id="error-tkgcc" style="display:none"></div>
      </section>
    </main>
  </div>

  <!-- GCC 生活 -->
  <div id="section-gcclife" style="display:none">
    <div class="lm-section-header">
      <h2>GCC 生活娱乐</h2>
      <span class="refresh-time" id="gccLifeTime" style="font-size:.75rem">--</span>
    </div>
    <main class="grid">
      <section class="column" data-platform="glytsa">
        <div class="column-header" style="--accent: #ff0000">
          <h2>YT Life · SA</h2>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="count" id="count-glytsa">0</span>
            <button class="lm-col-refresh-btn" onclick="refreshGccCol('glytsa')">⟳</button>
          </div>
        </div>
        <div class="lm-col-list" id="grid-glytsa">${'<div class="lm-card"><div class="lm-pic-wrap"><div class="skeleton-line" style="width:100%;aspect-ratio:16/9"></div></div><div class="lm-card-body"><div class="skeleton-line" style="width:80%"></div></div></div>'.repeat(6)}</div>
        <div class="error-banner" id="error-glytsa" style="display:none"></div>
      </section>
      <section class="column" data-platform="glytae">
        <div class="column-header" style="--accent: #009639">
          <h2>YT Life · UAE</h2>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="count" id="count-glytae">0</span>
            <button class="lm-col-refresh-btn" onclick="refreshGccCol('glytae')">⟳</button>
          </div>
        </div>
        <div class="lm-col-list" id="grid-glytae">${'<div class="lm-card"><div class="lm-pic-wrap"><div class="skeleton-line" style="width:100%;aspect-ratio:16/9"></div></div><div class="lm-card-body"><div class="skeleton-line" style="width:80%"></div></div></div>'.repeat(6)}</div>
        <div class="error-banner" id="error-glytae" style="display:none"></div>
      </section>
    </main>
  </div>

  <script>${APP_JS}</script>
</body>
</html>`;

// ─── Static route (single HTML with inline CSS + JS) ───
app.get('/', (req, res) => res.type('html').send(INDEX_HTML));

// ─── Start ───
setupProxy();
app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  热点聚合已启动!`);
  console.log(`  打开 ${url} 查看\n`);

  // Auto-open browser
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
    ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
});
