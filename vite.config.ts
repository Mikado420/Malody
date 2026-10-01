import { defineConfig } from 'vite';

// ビルドごとの版（GitHub Actions ではコミットの SHA）。
// version.json として一緒に公開し、アプリは起動時・復帰時にこれを見て新しい版があれば自動で読み直す。
const buildId = process.env.GITHUB_SHA ?? `local-${Date.now()}`;

export default defineConfig(({ command }) => ({
  // base: './' にしておくと GitHub Pages のサブパス (/リポジトリ名/) でもそのまま動く
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(command === 'serve' ? 'dev' : buildId),
  },
  plugins: [
    {
      name: 'version-json',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ id: buildId }) });
      },
    },
  ],
}));
