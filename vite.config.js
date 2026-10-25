import { mkdirSync, writeFileSync } from 'node:fs';

// The dev server watches the project for reloads. Cargo output and agent worktrees are tens of
// thousands of files that change on every build, so leave them out; sim/pkg (the WASM build)
// stays watched so a rebuild reloads the page.
// Two pages: the game (and lobby) at /, the guide at /guide/, whose sections (/guide/weapons,
// /guide/maps/foundry, ...) are all the one page, as the server serves them.
const SHOTS = new URL('./guide/shots/', import.meta.url);
export default {
  build: { rolldownOptions: { input: { main: 'index.html', guide: 'guide/index.html' } } },
  plugins: [{
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
