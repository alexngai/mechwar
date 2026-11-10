import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import GUIDE_MAPS from './guide/maps.json' with { type: 'json' };

// The dev server watches the project for reloads. Cargo output and agent worktrees are tens of
// thousands of files that change on every build, so leave them out; sim/pkg (the WASM build)
// stays watched so a rebuild reloads the page.
// Two pages: the game (and lobby) at /, the guide at /guide/, whose sections (/guide/weapons,
// /guide/maps/foundry, ...) are all the one page, as the server serves them.
const SHOTS = new URL('./guide/shots/', import.meta.url);
// For search engines: robots.txt, and a sitemap of the home page and every guide page (the sections
// its nav links to, and a page per map). The home page's link preview picture (og:image) goes at a fixed address.
const SITE = 'https://mechwar.online';
// Every guide page's title and description. Each page's HTML carries its own, with its canonical
// address, before any script runs: the build writes a copy of the guide per page (dist/guide/mechs.html,
// dist/guide/maps/foundry.html, ...), which the server serves at /guide/mechs, /guide/maps/foundry, ...
// One shared copy with these added by script reads, to a search engine that hasn't run it, as the
// same page at twenty addresses.
const ABOUT = {
  '/guide/': 'The MECHWAR field guide: the three mechs, every weapon, item and ability, the game modes and maps, and how it all plays.',
  '/guide/mechs': "MECHWAR's three mech classes, Light, Medium and Heavy: how fast and tough each is, the loadout each starts with, and how the rest unlocks as you level.",
  '/guide/weapons': 'Every MECHWAR weapon, primary and secondary: damage, range, heat and cooldown, and how many hits each takes to down a Light, a Medium and a Heavy.',
  '/guide/items': 'Every MECHWAR item, support item and ability: what each does, its charges or cooldown, and which mechs can carry it.',
  '/guide/modes': "MECHWAR's game modes, how each is played and won: Team Deathmatch, Deathmatch, Missile Assault, Siege, Capture the Flag, Convoy and Co-op Defense.",
  '/guide/maps': `All ${Object.keys(GUIDE_MAPS).length} MECHWAR maps, smallest first: each one's size, the modes it plays, its layout and the places worth knowing.`,
  '/guide/mechanics': 'The rules under every MECHWAR fight: movement, heat, damage, repair, health orbs, respawns, lock-ons, base guns, deployables and progression.',
};
const nav = readFileSync(new URL('./guide/index.html', import.meta.url), 'utf8').match(/<nav id="nav".*<\/nav>/)[0];
const GUIDE = [
  ...[...nav.matchAll(/href="([^"]+)">([^<]+)</g)].map(([, path, name]) => ({
    path,
    title: path === '/guide/' ? 'Guide · MECHWAR' : `${name[0]}${name.slice(1).toLowerCase()} · MECHWAR guide`,
    description: ABOUT[path] ?? (() => { throw new Error(`vite.config.js: no description (ABOUT) for the guide's ${path}`); })(),
  })),
  ...Object.entries(GUIDE_MAPS).map(([id, { blurb }]) => ({
    path: `/guide/maps/${id}`,
    title: `${JSON.parse(readFileSync(new URL(`./maps/${id}.json`, import.meta.url), 'utf8')).name} · MECHWAR guide`,
    description: blurb,
  })),
];
const PAGES = ['/', ...GUIDE.map(({ path }) => path)];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** The guide's HTML (guide/index.html, served or built) made guide page `page`'s own. */
const guidePage = (html, { path, title, description }) => {
  const own = html.replace(/<title>.*<\/title>/, `<title>${esc(title)}</title>`).replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${SITE}${path}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${SITE}${path}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="${SITE}/og.webp">
  <meta name="twitter:card" content="summary_large_image">`);
  if (!own.includes(`<title>${esc(title)}</title>`) || !own.includes('rel="canonical"')) throw new Error("vite.config.js: guide/index.html's <title> or description meta isn't where guidePage looks");
  return own;
};
export default {
  build: { rolldownOptions: { input: { main: 'index.html', guide: 'guide/index.html' } } },
  plugins: [{
    name: 'guide-pages',
    // After Vite's own HTML plugin has built guide/index.html (script tags pointing at the hashed bundles).
    enforce: 'post',
    generateBundle(_, bundle) {
      const built = bundle['guide/index.html'];
      const html = typeof built.source === 'string' ? built.source : new TextDecoder().decode(built.source);
      for (const page of GUIDE) {
        if (page.path === '/guide/') built.source = guidePage(html, page);
        else this.emitFile({ type: 'asset', fileName: `${page.path.slice(1)}.html`, source: guidePage(html, page) });
      }
    },
  }, {
    name: 'seo',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: `User-agent: *\nDisallow: /api/\n\nSitemap: ${SITE}/sitemap.xml\n` });
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.map((p) => `  <url><loc>${SITE}${p}</loc></url>`).join('\n')}
</urlset>
` });
      this.emitFile({ type: 'asset', fileName: 'og.webp', source: readFileSync(new URL('foundry-hero.webp', SHOTS)) });
    },
  }, {
    name: 'guide',
    apply: 'serve',
    // Each guide page's own title, description and canonical, as the build writes them into its copy.
    transformIndexHtml(html, { path, originalUrl = '' }) {
      if (path !== '/guide/index.html') return;
      const bare = (url) => url.replace(/[?#].*/, '').replace(/\/$/, '');
      return guidePage(html, GUIDE.find((page) => bare(page.path) === bare(originalUrl)) ?? GUIDE[0]);
    },
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (/^\/guide(\/[\w-]+){0,2}\/?(\?|$)/.test(req.url)) req.url = '/guide/index.html';
        next();
      });
      // tools/shoot.html saves the guide's map pictures here. The watcher leaves them be (a new one
      // would reload the page making them); restart the server to see them in the guide.
      server.middlewares.use('/__shots/', (req, res) => {
        const name = req.url.slice(1);
        if (req.method !== 'POST' || !/^[a-z]+-[a-z0-9-]+\.webp$/.test(name)) return void res.writeHead(400).end();
        const body = [];
        req.on('data', (chunk) => body.push(chunk));
        req.on('end', () => {
          mkdirSync(SHOTS, { recursive: true });
          writeFileSync(new URL(name, SHOTS), Buffer.concat(body));
          res.end();
        });
      });
    },
  }],
  server: {
    watch: { ignored: ['**/target/**', '**/.claude/**', '**/dist/**', '**/.omc/**', '**/.sessionlog/**', '**/guide/shots/**'] },
  },
};
