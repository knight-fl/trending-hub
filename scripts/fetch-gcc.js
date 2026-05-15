#!/usr/bin/env node
/* Fetch GCC trending via YouTube Data API v3 (official, free tier: 10k units/day).
   API key passed as YOUTUBE_API_KEY env var (set in GitHub Secrets). */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const API_KEY = process.env.YOUTUBE_API_KEY || '';
if (!API_KEY) { console.error('YOUTUBE_API_KEY not set'); process.exit(1); }

/* Fetch trending videos for a region */
async function fetchYoutube(region) {
  console.log(`  [yt-${region}] fetching via official API...`);
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&chart=mostPopular&regionCode=${region}&maxResults=50&key=${API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.text();
      console.log(`  [yt-${region}] HTTP ${res.status}: ${err.slice(0, 200)}`);
      return [];
    }
    const data = await res.json();
    const items = (data.items || []).map((item, idx) => ({
      rank: idx + 1,
      title:    item.snippet?.title || '',
      videoId:  item.id || '',
      author:   item.snippet?.channelTitle || '',
      viewCount: parseInt(item.statistics?.viewCount || '0', 10),
      thumb:    (item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '').replace(/^http:/, 'https:'),
      duration: item.contentDetails?.duration || '',
      url:      `https://www.youtube.com/watch?v=${item.id}`,
    }));
    console.log(`  [yt-${region}] ${items.length} videos`);
    return items;
  } catch (e) {
    console.log(`  [yt-${region}] error: ${e.message}`);
    return [];
  }
}

/* ─── TikTok GCC ─── */
async function fetchTiktok() {
  console.log('  [tiktok] fetching...');
  try {
    // Step 1: get cookies from TikTok homepage
    const cookieRes = await fetch('https://www.tiktok.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      redirect: 'manual',
    });
    const cookies = cookieRes.headers.get('set-cookie') || '';

    // Step 2: try TikTok trending API
    const endpoints = [
      'https://www.tiktok.com/api/trending/item_list/?aid=1988&app_name=tiktok_web&device_platform=web&region=SA&count=50',
      'https://www.tiktok.com/api/recommend/item_list/?aid=1988&app_name=tiktok_web&device_platform=web&region=SA&count=50',
    ];

    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Referer: 'https://www.tiktok.com/',
            Cookie: cookies,
          },
        });
        console.log(`  [tiktok] ${url.slice(30,55)} HTTP ${res.status}`);
        if (!res.ok) continue;
        const json = await res.json();
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
  console.log('  [tiktok] 0 items (API may have changed)');
  return [];
}

/* ─── Main ─── */
(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('Fetching GCC data...');

  const [ytSA, ytAE, tiktok] = await Promise.all([fetchYoutube('SA'), fetchYoutube('AE'), fetchTiktok()]);

  const gccTop  = { updated: new Date().toISOString(), youtube_sa: ytSA, youtube_ae: ytAE, tiktok };
  const gccLife = { updated: new Date().toISOString(), youtube_sa: ytSA.slice(0, 20), youtube_ae: ytAE.slice(0, 20) };

  fs.writeFileSync(path.join(DATA_DIR, 'gcc-top.json'),  JSON.stringify(gccTop));
  fs.writeFileSync(path.join(DATA_DIR, 'gcc-life.json'), JSON.stringify(gccLife));

  const total = ytSA.length + ytAE.length + tiktok.length;
  console.log(`Done: yt-SA=${ytSA.length} yt-AE=${ytAE.length} tiktok=${tiktok.length} total=${total}`);
  if (total === 0) process.exit(1);
})();
