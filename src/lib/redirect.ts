/** Static redirect page for URLs of the old site (GitHub Pages and Caddy serve plain files). */
export function redirectPage(to: string, site: URL) {
  const url = new URL(to, site).href;
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Redirecting…</title>` +
      `<link rel="canonical" href="${url}"><meta name="robots" content="noindex">` +
      `<meta http-equiv="refresh" content="0; url=${to}"></head>` +
      `<body><a href="${to}">${url}</a></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}
