// The dev server watches the project for reloads. Cargo output and agent worktrees are tens of
// thousands of files that change on every build, so leave them out; sim/pkg (the WASM build)
// stays watched so a rebuild reloads the page.
export default {
  server: {
    watch: { ignored: ['**/target/**', '**/.claude/**', '**/dist/**', '**/.omc/**', '**/.sessionlog/**'] },
  },
};
