#!/usr/bin/env node
/* Fetch GCC trending data from YouTube (via Invidious) and TikTok.
   Runs on GitHub Actions (US servers). Writes JSON to data/ directory. */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TIMEOUT = 15000;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

async function fetchWithTimeout(url, opts = {}, ms = TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

/* ─── YouTube via Invidious ─── */
async function fetchYoutube(region) {
  const instances = ['https://inv.nadeko.net', 'https://yewtu.be'];
  for (const base of instances) {
    try {
      const r = await fetchWithTimeout(`${base}/api/v1/trending?region=${region}`, { headers: HEADERS });
      if (!r.ok) continue;
      const data = await r.json();
      if (Array.isArray(data) && data.length) {
        console.log(`  [yt-${region}] ${data.length} items via ${base}`);
        return data.slice(0, 50).map((v, idx) => ({
          rank: idx + 1,
          title: v.title || '',
          videoId: v.videoId,
          author: v.author || '',
          viewCount: v.viewCount || 0,
          lengthSeconds: v.lengthSeconds || 0,
          thumb: (v.videoThumbnails?.[0]?.url || '').replace(/^http:/, 'https:'),
          publishedText: v.publishedText || '',
          url: `https://www.youtube.com/watch?v=${v.videoId}`,
        }));
      }
    } catch (e) { console.log(`  [yt-${region}] ${base}: ${e.message}`); }
  }
  console.log(`  [yt-${region}] ALL FAILED -> empty`);
  return [];
}

/* ─── TikTok GCC ─── */
async function fetchTiktok() {
  // TikTok trending API — similar to Douyin cookie-based approach
  try {
    const cookieRes = await fetchWithTimeout('https://www.tiktok.com/', {
      headers: { ...HEADERS, Referer: 'https://www.tiktok.com/' },
    });
    const setCookie = cookieRes.headers.get('set-cookie') || '';
    const endpoints = [
      `https://www.tiktok.com/api/trending/item_list/?aid=1988&app_name=tiktok_web&device_platform=web&region=SA&count=50`,
      `https://www.tiktok.com/api/recommend/item_list/?aid=1988&app_name=tiktok_web&device_platform=web&region=SA&count=50`,
    ];
    for (const url of endpoints) {
      try {
        const r = await fetchWithTimeout(url, {
          headers: { ...HEADERS, Referer: 'https://www.tiktok.com/', Cookie: setCookie },
        });
        if (!r.ok) continue;
        const json = await r.json();
        const items = json?.itemList || json?.items || json?.aweme_list || [];
        if (Array.isArray(items) && items.length) {
          console.log(`  [tiktok] ${items.length} items`);
          return items.slice(0, 50).map((item, idx) => ({
            rank: idx + 1,
            title: item.desc || '',
            id: item.id || '',
            author: item.author?.nickname || item.author?.uniqueId || '',
            playCount: item.stats?.playCount || 0,
            thumb: (item.video?.cover?.url_list?.[0] || '').replace(/^http:/, 'https:'),
            url: item.id ? `https://www.tiktok.com/@${item.author?.uniqueId || 'user'}/video/${item.id}` : '',
          }));
        }
      } catch (e) { console.log(`  [tiktok] api: ${e.message}`); }
    }
  } catch (e) { console.log(`  [tiktok] cookie: ${e.message}`); }
  console.log('  [tiktok] ALL FAILED -> empty');
  return [];
}

/* ─── Main ─── */
(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('Fetching GCC data...');

  const [ytSA, ytAE, tiktok] = await Promise.all([
    fetchYoutube('SA'),
    fetchYoutube('AE'),
    fetchTiktok(),
  ]);

  const gccTop = {
    updated: new Date().toISOString(),
    youtube_sa: ytSA,
    youtube_ae: ytAE,
    tiktok: tiktok,
  };

  const gccLife = {
    updated: new Date().toISOString(),
    youtube_sa: ytSA.slice(0, 20),
    youtube_ae: ytAE.slice(0, 20),
  };

  fs.writeFileSync(path.join(DATA_DIR, 'gcc-top.json'), JSON.stringify(gccTop));
  fs.writeFileSync(path.join(DATA_DIR, 'gcc-life.json'), JSON.stringify(gccLife));

  console.log(`Done: yt-SA=${ytSA.length} yt-AE=${ytAE.length} tiktok=${tiktok.length}`);
})();
