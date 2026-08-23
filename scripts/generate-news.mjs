// Fetches tech news from public RSS feeds and regenerates news.html.
// No external dependencies — plain fetch + regex-based RSS/Atom parsing,
// so it runs on a stock GitHub Actions Node runner with no npm install step.

const FEEDS = [
  { name: 'Hacker News', url: 'https://hnrss.org/frontpage', category: 'Community' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'Startups' },
  { name: 'Dev.to', url: 'https://dev.to/feed', category: 'Dev' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', category: 'Tech' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', category: 'Tech' },
];

const MAX_AGE_HOURS = 72;
const MAX_PER_FEED = 4;
const MAX_TOTAL = 16;
const OUTPUT_PATH = new URL('../news.html', import.meta.url);

function decodeEntities(str) {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripTags(str) {
  return decodeEntities(str).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

function extractLink(block) {
  const atomLink = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
    || block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (atomLink) return atomLink[1];
  const rssLink = extractTag(block, 'link');
  return decodeEntities(rssLink);
}

function parseFeed(xml) {
  const entries = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  return entries.map((block) => {
    const title = stripTags(extractTag(block, 'title'));
    const link = extractLink(block).trim();
    const rawDate = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated');
    const date = rawDate ? new Date(rawDate) : null;
    const rawSummary = extractTag(block, 'content:encoded') || extractTag(block, 'description') || extractTag(block, 'summary');
    const summary = stripTags(rawSummary).slice(0, 220);
    return { title, link, date, summary };
  }).filter((item) => item.title && item.link);
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TechNewsBot/1.0; +https://jeffev.github.io/jeffersonvalandro/)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = parseFeed(xml)
      .filter((item) => !item.date || Number.isFinite(item.date.getTime()))
      .slice(0, MAX_PER_FEED)
      .map((item) => ({ ...item, source: feed.name, category: feed.category }));
    return items;
  } catch (err) {
    console.warn(`[generate-news] Failed to fetch ${feed.name}: ${err.message}`);
    return [];
  }
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(date) {
  if (!date) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderCard(item) {
  const dateLabel = formatDate(item.date);
  return `      <article class="news-card">
        <div class="news-card-top">
          <span class="news-source">${escapeHtml(item.source)} &middot; ${escapeHtml(item.category)}</span>
          ${dateLabel ? `<span class="news-date">${dateLabel}</span>` : ''}
        </div>
        <h2 class="news-title"><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a></h2>
        ${item.summary ? `<p class="news-summary">${escapeHtml(item.summary)}${item.summary.length >= 220 ? '…' : ''}</p>` : ''}
      </article>`;
}

function renderPage(items, generatedAt) {
  const updatedLabel = generatedAt.toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
  });
  const cardsHtml = items.length
    ? items.map(renderCard).join('\n')
    : '      <p class="news-empty">No fresh headlines right now — check back later.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tech News Digest — Jefferson Valandro</title>
  <meta name="description" content="Curated headlines from around the software industry, refreshed daily.">
  <meta name="author" content="Jefferson Valandro">
  <link rel="canonical" href="https://jeffev.github.io/jeffersonvalandro/news.html">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://jeffev.github.io/jeffersonvalandro/news.html">
  <meta property="og:title" content="Tech News Digest — Jefferson Valandro">
  <meta property="og:description" content="Curated headlines from around the software industry, refreshed daily.">
  <meta name="theme-color" content="#070d1a">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" crossorigin="anonymous" referrerpolicy="no-referrer">
  <link rel="stylesheet" href="css/articles.css">
  <style>
    .news-list { display: flex; flex-direction: column; gap: 14px; margin-top: 1rem; max-width: 780px; }
    .news-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; transition: border-color .2s; }
    .news-card:hover { border-color: var(--article-accent); }
    .news-card-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
    .news-source { font-family: 'JetBrains Mono', monospace; font-size: .72rem; font-weight: 600; color: var(--article-accent); text-transform: uppercase; letter-spacing: .5px; }
    .news-date { font-size: .75rem; color: var(--muted); }
    .news-title { font-size: 1.05rem; font-weight: 700; line-height: 1.4; margin-bottom: 6px; }
    .news-title a { color: var(--text); text-decoration: none; }
    .news-title a:hover { color: var(--article-accent); }
    .news-summary { font-size: .9rem; color: var(--muted); line-height: 1.6; }
    .news-empty { color: var(--muted); text-align: center; padding: 40px 0; }
    .news-disclaimer { max-width: 780px; margin-top: 2.5rem; padding-top: 1.5rem; border-top: 1px solid var(--border); font-size: .8rem; color: var(--muted); }
  </style>
</head>
<body>

<nav>
  <a href="index.html" class="nav-logo">Jefferson<span>.</span></a>
  <a href="index.html#articles" class="nav-back"><i class="fas fa-arrow-left"></i> Back to Home</a>
</nav>

<header class="hero-article">
  <div class="hero-inner">
    <div class="article-category"><i class="fas fa-newspaper"></i> Auto-updated daily</div>
    <h1>Tech News Digest</h1>
    <div class="article-meta">
      <span><i class="fas fa-rotate"></i> Updated ${updatedLabel}</span>
      <span><i class="fas fa-rss"></i> ${items.length} headlines</span>
    </div>
  </div>
</header>

<article class="article-content">
  <div class="news-list">
${cardsHtml}
  </div>
  <p class="news-disclaimer">Headlines and summaries are fetched automatically from public RSS feeds (Hacker News, TechCrunch, Dev.to, The Verge, Ars Technica). All credit belongs to the original publishers &mdash; click a headline to read the full story at the source.</p>
</article>

</body>
</html>
`;
}

async function main() {
  const results = await Promise.all(FEEDS.map(fetchFeed));
  let items = dedupe(results.flat());

  const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000;
  const fresh = items.filter((item) => !item.date || item.date.getTime() >= cutoff);
  items = (fresh.length ? fresh : items)
    .sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0))
    .slice(0, MAX_TOTAL);

  if (items.length === 0) {
    console.warn('[generate-news] No items fetched from any feed — leaving existing news.html untouched.');
    return;
  }

  const html = renderPage(items, new Date());
  await import('node:fs/promises').then((fs) => fs.writeFile(OUTPUT_PATH, html, 'utf-8'));
  console.log(`[generate-news] Wrote ${items.length} headlines to news.html`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
