/* ─── State ─── */
const state = {
  platforms: ['bilibili', 'weibo', 'douyin'],
  lastRefresh: null,
  timer: null,
  isLoading: { bilibili: false, weibo: false, douyin: false },
};

/* ─── Platform display config ─── */
const PLATFORM = {
  bilibili: { label: 'B站', accent: '#fb7299' },
  weibo:    { label: '微博', accent: '#ff8200' },
  douyin:   { label: '抖音', accent: '#00a8ff' },
};

/* ─── Fetch ─── */
async function fetchPlatform(platform, noCache) {
  const url = `/api/${platform}${noCache ? '?noCache=1' : ''}`;
  const res = await fetch(url);
  return res.json();
}

/* ─── Render ─── */
function renderPlatform(platform, data) {
  const list = document.getElementById(`list-${platform}`);
  const errorEl = document.getElementById(`error-${platform}`);
  const countEl = document.getElementById(`count-${platform}`);

  // Hide error
  errorEl.style.display = 'none';

  if (!data.success) {
    list.innerHTML = '';
    countEl.textContent = '0';
    errorEl.style.display = 'flex';
    errorEl.innerHTML = `
      <span>${data.error || '获取失败'}</span>
      <button onclick="refreshOne('${platform}')">重试</button>
    `;
    return;
  }

  // Show stale badge if needed
  const header = document.querySelector(`.column[data-platform="${platform}"] .column-header`);
  let staleBadge = header.querySelector('.stale-warning');
  if (data.stale) {
    if (!staleBadge) {
      staleBadge = document.createElement('span');
      staleBadge.className = 'stale-warning';
      staleBadge.textContent = '⚠ 数据可能延迟';
      header.appendChild(staleBadge);
    }
  } else if (staleBadge) {
    staleBadge.remove();
  }

  countEl.textContent = data.items.length;
  list.innerHTML = data.items.map(item => {
    const rankClass = item.rank === 1 ? 'top1' : item.rank === 2 ? 'top2' : item.rank === 3 ? 'top3' : '';
    const authorHtml = item.author ? `<span class="item-author">${item.author}</span>` : '';
    return `
      <li>
        <span class="rank ${rankClass}">${item.rank}</span>
        <a class="item-title" href="${item.url}" target="_blank" rel="noopener" style="--accent: ${PLATFORM[platform].accent}">
          ${escapeHtml(item.title)}
        </a>
        ${authorHtml}
        <span class="item-hot">${item.hot}</span>
      </li>
    `;
  }).join('');
}

function renderError(platform, msg) {
  const list = document.getElementById(`list-${platform}`);
  const errorEl = document.getElementById(`error-${platform}`);
  const countEl = document.getElementById(`count-${platform}`);
  list.innerHTML = '';
  countEl.textContent = '0';
  errorEl.style.display = 'flex';
  errorEl.innerHTML = `
    <span>${msg}</span>
    <button onclick="refreshOne('${platform}')">重试</button>
  `;
}

/* ─── Refresh ─── */
async function refreshAll(noCache) {
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true;
  btn.textContent = '⟳ 刷新中...';

  try {
    const results = await Promise.allSettled(
      state.platforms.map(p => fetchPlatform(p, noCache))
    );

    results.forEach((result, i) => {
      const platform = state.platforms[i];
      if (result.status === 'fulfilled') {
        renderPlatform(platform, result.value);
      } else {
        renderError(platform, '网络请求失败');
      }
    });

    state.lastRefresh = Date.now();
    updateLastRefreshTime();
  } finally {
    btn.disabled = false;
    btn.textContent = '⟳ 刷新全部';
  }
}

async function refreshOne(platform) {
  const data = await fetchPlatform(platform, true);
  renderPlatform(platform, data);
  state.lastRefresh = Date.now();
  updateLastRefreshTime();
}

/* ─── Auto refresh timer ─── */
function startAutoRefresh() {
  refreshAll(false);
  state.timer = setInterval(() => {
    if (state.lastRefresh && (Date.now() - state.lastRefresh >= 3600_000)) {
      refreshAll(false);
    }
  }, 60_000);
}

/* ─── UI helpers ─── */
function updateLastRefreshTime() {
  const el = document.getElementById('lastRefresh');
  if (state.lastRefresh) {
    const d = new Date(state.lastRefresh);
    const pad = n => String(n).padStart(2, '0');
    el.textContent = `上次更新：${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ─── Init ─── */
window.addEventListener('load', startAutoRefresh);
