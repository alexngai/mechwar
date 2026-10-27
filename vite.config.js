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
const nav = readFileSync(new URL('./guide/index.html', import.meta.url), 'utf8').match(/<nav id="nav".*<\/nav>/)[0];
const PAGES = ['/', ...[...nav.matchAll(/href="([^"]+)"/g)].map(([, href]) => href), ...Object.keys(GUIDE_MAPS).map((id) => `/guide/maps/${id}`)];
export default {
  build: { rolldownOptions: { input: { main: 'index.html', guide: 'guide/index.html' } } },
  plugins: [{
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
