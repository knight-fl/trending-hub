#!/usr/bin/env node
/* Fetch GCC trending data using yt-dlp + TikTok best-effort.
   Runs on GitHub Actions. */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');

/* ─── YouTube via yt-dlp (pip install yt-dlp) ─── */
async function fetchYoutube(region) {
  console.log(`  [yt-${region}] yt-dlp...`);
  try {
    const cmd = `yt-dlp --no-download --dump-json --playlist-end 30 --flat-playlist "https://www.youtube.com/feed/trending?gl=${region}"`;
    const raw = execSync(cmd, { encoding: 'utf8', timeout: 90000, maxBuffer: 5*1024*1024 });
    const lines = raw.trim().split('\n').filter(Boolean);
    if (!lines.length) { console.log(`  [yt-${region}] 0 lines`); return []; }

    const videos = lines.map((line, i) => {
      try {
        const v = JSON.parse(line);
        return {
          rank: i+1,
          title: v.title || v.fulltitle || '',
          videoId: v.id || v.display_id || '',
          author: v.uploader || v.channel || '',
          viewCount: v.view_count || 0,
          thumb: (v.thumbnail || '').replace(/^http:/, 'https:'),
          duration: v.duration_string || '',
          url: v.webpage_url || `https://www.youtube.com/watch?v=${v.id}`,
        };
      } catch (_) { return null; }
    }).filter(Boolean);

    console.log(`  [yt-${region}] ${videos.length} videos`);
    return videos;
  } catch (e) {
    console.log(`  [yt-${region}] error: ${e.message}`);
    return [];
  }
}

/* ─── Main ─── */
(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('Fetching GCC data...');

  const [ytSA, ytAE] = await Promise.all([fetchYoutube('SA'), fetchYoutube('AE')]);

  const gccTop  = { updated: new Date().toISOString(), youtube_sa: ytSA, youtube_ae: ytAE, tiktok: [] };
  const gccLife = { updated: new Date().toISOString(), youtube_sa: ytSA.slice(0,20), youtube_ae: ytAE.slice(0,20) };

  fs.writeFileSync(path.join(DATA_DIR, 'gcc-top.json'),  JSON.stringify(gccTop));
  fs.writeFileSync(path.join(DATA_DIR, 'gcc-life.json'), JSON.stringify(gccLife));

  const total = ytSA.length + ytAE.length;
  console.log(`Done: yt-SA=${ytSA.length} yt-AE=${ytAE.length} total=${total}`);
  if (total === 0) process.exit(1);
})();
