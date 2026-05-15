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

/* ─── TikTok via omkarcloud ─── */
const TK_API_KEY = process.env.TIKTOK_SCRAPER_API_KEY || '';
const TK_BASE = 'https://tiktok-scraper.omkar.cloud';

async function fetchTiktok() {
  // Method 1: tiktok-scrape-trend (free, no API key)
  try {
    console.log('  [tiktok:free] trying tiktok-scrape-trend...');
    // Dynamic require handles ESM-in-CJS
    const mod = require('tiktok-scrape-trend');
    const trendFn = mod.default || mod;
    const videos = typeof trendFn === 'function' ? await trendFn({ region: 'SA', count: 20 }) : [];
    if (Array.isArray(videos) && videos.length) {
      console.log(`  [tiktok:free] ${videos.length} items`);
      return videos.slice(0, 20).map((v, idx) => ({
        rank: idx + 1,
        title: v.caption || v.title || v.desc || '',
        id: v.video_id || v.id || '',
        author: v.author?.handle || v.author?.username || v.uploader || '',
        playCount: v.stats?.playCount || v.play_count || v.views || 0,
        thumb: (v.thumbnails?.cover_url || v.thumbnail || v.cover || '').replace(/^http:/, 'https:'),
        url: `https://www.tiktok.com/@${v.author?.handle||'user'}/video/${v.video_id||v.id}`,
      }));
    }
    console.log('  [tiktok:free] no items returned');
  } catch (e) { console.log(`  [tiktok:free] ${e.message}`); }

  // Method 2: omkarcloud (paid fallback)
  if (TK_API_KEY) {
    console.log('  [tiktok:paid] trying omkarcloud...');
    try {
      const res = await fetch(`${TK_BASE}/tiktok/videos/trending?market=SA&max_results=20`, {
        headers: { 'API-Key': TK_API_KEY },
      });
      console.log(`  [tiktok:paid] HTTP ${res.status}`);
      if (res.ok) {
        const json = await res.json();
        const items = json?.data || json?.items || json?.videos || [];
        if (items.length) {
          console.log(`  [tiktok:paid] ${items.length} items`);
          return items.slice(0, 20).map((item, idx) => ({
            rank: idx + 1,
            title: item.caption || item.title || '',
            id: item.video_id || item.id || '',
            author: item.author?.handle || item.author?.nickname || '',
            playCount: item.stats?.playCount || item.stats?.views || 0,
            thumb: (item.thumbnails?.cover_url || '').replace(/^http:/, 'https:'),
            url: `https://www.tiktok.com/@${item.author?.handle||'user'}/video/${item.video_id}`,
          }));
        }
      }
    } catch (e) { console.log(`  [tiktok:paid] ${e.message}`); }
  }

  console.log('  [tiktok] 0 items (both methods failed)');
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
