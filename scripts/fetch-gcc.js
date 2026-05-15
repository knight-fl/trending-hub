#!/usr/bin/env node
/* Fetch GCC trending data from YouTube and TikTok.
   Runs on GitHub Actions (US servers). Writes JSON to data/ directory. */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
};

/* Simple fetch with timeout that works on all Node versions */
function fetchText(url, opts = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search,
      method: 'GET', headers: { ...HEADERS, ...(opts.headers||{}) },
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, text: data, headers: res.headers }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

/* ─── YouTube: extract ytInitialData from trending page ─── */
async function fetchYoutube(region) {
  console.log(`  [yt-${region}] fetching trending page...`);
  try {
    const res = await fetchText(`https://www.youtube.com/feed/trending?gl=${region}`, {
      headers: {
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    console.log(`  [yt-${region}] HTTP ${res.status}, body ${res.text.length} bytes`);

    if (!res.ok) { console.log(`  [yt-${region}] bad status`); return []; }

    // Extract ytInitialData JSON from HTML
    const match = res.text.match(/var ytInitialData\s*=\s*({.*?});<\/script>/s);
    if (!match) {
      // Debug: show what's near "ytInitial" in the HTML
      const idx = res.text.indexOf('ytInitial');
      if (idx > 0) console.log(`  [yt-${region}] ytInitial at ${idx}, nearby: ` + res.text.slice(Math.max(0,idx-20), idx+200));
      else console.log(`  [yt-${region}] ytInitial NOT in HTML at all`);
      return [];
    }

    const data = JSON.parse(match[1]);
    const videos = extractVideos(data, region);
    console.log(`  [yt-${region}] extracted ${videos.length} videos`);
    return videos;
  } catch (e) {
    console.log(`  [yt-${region}] error: ${e.message}`);
    return [];
  }
}

/* Recursively walk ytInitialData to find videoRenderer objects */
function extractVideos(data, region) {
  const videos = [];
  const seen = new Set();

  function walk(obj) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
    seen.add(obj);
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    for (const key of Object.keys(obj)) {
      if (key === 'videoRenderer' && obj[key] && obj[key].videoId) {
        const v = obj[key];
        const vid = v.videoId;
        if (!videos.find(x => x.videoId === vid)) {
          const title = v.title?.runs?.[0]?.text || v.title?.simpleText || '';
          const author = v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || '';
          const viewStr = v.viewCountText?.simpleText || v.viewCountText?.runs?.map(r=>r.text).join('') || '0';
          const viewCount = parseInt(viewStr.replace(/[^0-9]/g, ''), 10) || 0;
          const thumb = (v.thumbnail?.thumbnails || [])[0]?.url || '';
          const length = v.lengthText?.simpleText || '';
          videos.push({
            rank: 0, title, videoId: vid, author, viewCount, lengthSeconds: 0,
            thumb: thumb.replace(/^http:/, 'https:'),
            lengthText: length,
            url: `https://www.youtube.com/watch?v=${vid}`,
          });
        }
      }
      if (typeof obj[key] === 'object') walk(obj[key]);
    }
  }
  walk(data);

  return videos.slice(0, 50).map((v, i) => ({ ...v, rank: i + 1 }));
}

/* ─── TikTok GCC ─── */
async function fetchTiktok() {
  console.log('  [tiktok] fetching...');
  try {
    // Try TikTok trending API
    const cookieRes = await fetchText('https://www.tiktok.com/', {
      headers: { Referer: 'https://www.tiktok.com/' },
    });
    const setCookie = cookieRes.headers?.['set-cookie']?.join('; ') || '';

    // Try multiple endpoints
    for (const ep of [
      '/api/trending/item_list/?aid=1988&app_name=tiktok_web&device_platform=web&region=SA&count=50',
      '/api/recommend/item_list/?aid=1988&app_name=tiktok_web&device_platform=web&region=SA&count=50',
    ]) {
      try {
        const res = await fetchText(`https://www.tiktok.com${ep}`, {
          headers: { Referer: 'https://www.tiktok.com/', Cookie: setCookie },
        });
        console.log(`  [tiktok] endpoint ${ep.slice(0,30)} HTTP ${res.status}`);
        if (!res.ok) continue;
        const json = JSON.parse(res.text);
        const items = json?.itemList || json?.items || json?.aweme_list || [];
        if (items.length) {
          console.log(`  [tiktok] ${items.length} items`);
          return items.slice(0, 50).map((item, idx) => ({
            rank: idx + 1,
            title: item.desc || '',
            id: item.id || '',
            author: item.author?.nickname || item.author?.uniqueId || '',
            playCount: item.stats?.playCount || 0,
            thumb: (item.video?.cover?.url_list?.[0] || '').replace(/^http:/, 'https:'),
            url: item.id ? `https://www.tiktok.com/@${item.author?.uniqueId||'user'}/video/${item.id}` : '',
          }));
        }
      } catch (e) { console.log(`  [tiktok] ${e.message}`); }
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

  const total = ytSA.length + ytAE.length + tiktok.length;
  console.log(`Done: yt-SA=${ytSA.length} yt-AE=${ytAE.length} tiktok=${tiktok.length} total=${total}`);
  if (total === 0) process.exit(1); // Signal failure so workflow knows
})();
