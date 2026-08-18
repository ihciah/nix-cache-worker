const DEFAULT_CACHE_ORIGIN = "https://cache.example.org";
const DEFAULT_REPOSITORY_URL = "https://github.com/ihciah/nix-cache-worker";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function cacheHost(origin: string): string {
  try {
    return new URL(origin).host || "cache.example.org";
  } catch {
    return "cache.example.org";
  }
}

function productFooter(): string {
  return `<footer class="site-footer">Powered by <a href="${escapeHtml(DEFAULT_REPOSITORY_URL)}" target="_blank" rel="noreferrer">NixCacheWorker</a></footer>`;
}

export function homePage(
  publicSigningKey?: string,
  publicOrigin = DEFAULT_CACHE_ORIGIN,
): Response {
  const origin = publicOrigin.replace(/\/+$/, "") || DEFAULT_CACHE_ORIGIN;
  const signingKey = publicSigningKey || `${cacheHost(origin)}:<public-signing-key>`;
  const publicKey = escapeHtml(signingKey);
  const footer = productFooter();
  const nixModuleConfig = escapeHtml(`substituters = lib.mkForce [
  "https://cache.nixos.org"
  "${origin}"
];

trusted-public-keys = lib.mkForce [
  "cache.nixos.org-1:<existing-cache-key>"
  "${signingKey}"
];`);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nix Cache Worker</title>
  <style>
    :root { color-scheme: dark; --bg: #101313; --panel: #171b1b; --panel-2: #1d2423; --line: #303937; --text: #edf3ef; --muted: #9ca9a3; --green: #9de2b5; --green-2: #4fbb7b; --amber: #e8c87f; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 80% -10%, #244037 0, transparent 42%), var(--bg); color: var(--text); font: 14px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; }
    a { color: inherit; }
    .home-shell { min-height: 100vh; display: flex; flex-direction: column; }
    .home-nav, .home-main, .site-footer { width: min(1080px, 100%); margin: 0 auto; }
    .home-nav { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 28px clamp(18px, 4vw, 42px); }
    .brand { color: var(--green); font-size: 12px; font-weight: 800; letter-spacing: .18em; text-decoration: none; }
    .admin-link { color: var(--muted); font-size: 12px; text-decoration: none; border: 1px solid var(--line); border-radius: 999px; padding: 7px 11px; transition: color .15s ease, border-color .15s ease, background .15s ease; }
    .admin-link:hover, .admin-link:focus-visible { color: var(--green); border-color: var(--green-2); background: #193025; outline: none; }
    .home-main { flex: 1; padding: 54px clamp(18px, 4vw, 42px) 34px; }
    .hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, .8fr); gap: clamp(30px, 7vw, 90px); align-items: center; margin-bottom: 54px; }
    .eyebrow { color: var(--green); text-transform: uppercase; letter-spacing: .16em; font-size: 11px; font-weight: 750; }
    h1 { max-width: 680px; margin: 13px 0 16px; font-size: clamp(36px, 6vw, 64px); line-height: 1.03; letter-spacing: -.045em; }
    .hero-copy { max-width: 620px; color: var(--muted); font-size: 17px; }
    .hero-copy strong { color: var(--text); font-weight: 650; }
    .hero-mark { position: relative; min-height: 245px; display: grid; place-items: center; border: 1px solid #355745; border-radius: 28px; background: linear-gradient(145deg, rgba(35, 71, 54, .82), rgba(17, 28, 24, .86)); box-shadow: 0 24px 80px #0004; overflow: hidden; }
    .hero-mark::before, .hero-mark::after { content: ""; position: absolute; border: 1px solid #5eaa7d55; border-radius: 50%; }
    .hero-mark::before { width: 230px; height: 230px; }
    .hero-mark::after { width: 150px; height: 150px; }
    .mark-core { position: relative; z-index: 1; display: grid; place-items: center; width: 92px; height: 92px; border: 1px solid #b0e9c1; border-radius: 24px; color: #0b1c12; background: var(--green); box-shadow: 0 0 0 13px #9de2b51c, 0 16px 36px #0005; font-size: 34px; font-weight: 850; letter-spacing: -.08em; }
    .guide { border: 1px solid var(--line); border-radius: 20px; background: rgba(23, 27, 27, .9); overflow: hidden; }
    .guide-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 24px 26px; border-bottom: 1px solid var(--line); background: linear-gradient(110deg, #1b2923, #171b1b); }
    h2 { margin: 5px 0 5px; font-size: 23px; letter-spacing: -.02em; }
    .subtle { color: var(--muted); margin: 0; }
    .guide-label { flex: 0 0 auto; color: #c7ead1; border: 1px solid #3d7554; border-radius: 999px; padding: 6px 10px; font-size: 11px; white-space: nowrap; }
    .steps { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--line); }
    .step { min-width: 0; padding: 23px 26px; background: var(--panel); }
    .step.wide { grid-column: 1 / -1; }
    .step-index { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; color: #e9fff0; background: #2e6e50; font-size: 12px; font-weight: 800; }
    .step h3 { display: inline; margin-left: 8px; font-size: 15px; }
    .step p { color: var(--muted); margin: 10px 0 0 32px; font-size: 12px; }
    .code-wrap { position: relative; margin: 15px 0 0 32px; }
    pre { margin: 0; padding: 15px 16px; overflow-x: auto; color: #d8f2df; background: #0c1210; border: 1px solid #2e493d; border-radius: 10px; font: 12px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; }
    .key-line { margin-top: 15px; padding: 11px 13px; overflow-wrap: anywhere; color: #d8f2df; background: #0c1210; border: 1px solid #2e493d; border-radius: 10px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .note { padding: 18px 26px 21px; color: var(--muted); border-top: 1px solid var(--line); font-size: 12px; }
    .note strong { color: var(--text); }
    .site-footer { padding: 0 clamp(18px, 4vw, 42px) 28px; color: #718078; font-size: 11px; letter-spacing: .025em; line-height: 1.4; text-align: center; }
    .site-footer a { color: #9ab9a4; text-decoration: none; border-bottom: 1px solid transparent; transition: color .15s ease, border-color .15s ease; }
    .site-footer a:hover, .site-footer a:focus-visible { color: var(--green); border-bottom-color: var(--green-2); outline: none; }
    @media (max-width: 760px) { .home-nav { padding-top: 20px; } .home-main { padding-top: 28px; } .hero { grid-template-columns: 1fr; margin-bottom: 34px; } .hero-mark { min-height: 180px; } .steps { grid-template-columns: 1fr; } .step.wide { grid-column: auto; } .guide-head { display: block; } .guide-label { display: inline-block; margin-top: 14px; } }
  </style>
</head>
<body>
  <div class="home-shell">
    <header class="home-nav"><a class="brand" href="/">NIX CACHE WORKER</a><a class="admin-link" href="/admin">Admin console <span aria-hidden="true">↗</span></a></header>
    <main class="home-main">
      <section class="hero">
        <div><div class="eyebrow">Public Nix binary cache</div><h1>Stop building in production.</h1><p class="hero-copy">Build your Nix artifacts in CI, push them to your private cache, and deploy instantly.</p></div>
        <div class="hero-mark" aria-hidden="true"><div class="mark-core">NIX</div></div>
      </section>
      <section class="guide" aria-labelledby="guide-title">
        <div class="guide-head"><div><div class="eyebrow">Getting started</div><h2 id="guide-title">Add the cache to NixOS or nix-darwin</h2><p class="subtle">Keep your existing cache.nixos.org entry and add this cache alongside it.</p></div><span class="guide-label">Client setup</span></div>
        <div class="steps">
          <article class="step wide"><span class="step-index">1</span><h3>Use the full module configuration</h3><p>This example intentionally keeps the official cache and its existing signing key. Replace only the placeholder with the key you already use for cache.nixos.org.</p><div class="code-wrap"><pre>${nixModuleConfig}</pre></div></article>
          <article class="step"><span class="step-index">2</span><h3>Verify the public key</h3><p>Worker-signed narinfos use this public key:</p><div class="key-line">${publicKey}</div></article>
          <article class="step"><span class="step-index">3</span><h3>Apply and build normally</h3><p>After deploying the module, continue using your normal Nix commands. Existing substituters remain available.</p></article>
        </div>
        <div class="note"><strong>About <code>lib.mkForce</code>:</strong> it makes this module's complete lists authoritative. Keep the official cache entry and its real key in the lists as shown; do not replace them with only the Worker values.</div>
      </section>
    </main>
    ${footer}
  </div>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
