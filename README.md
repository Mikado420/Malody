# web-taiko

ブラウザで遊べる太鼓系リズムゲーム（Malody の Taiko モードのようなもの）。
TJA 譜面と音源ファイルを読み込んで、キーボードかタッチで遊べます。

## 遊び方

- **キーボード**: `F` `J` = ドン（面） / `D` `K` = カッ（フチ） / `Esc` = 中断
- **タッチ**: 画面下の太鼓の内側 = ドン、外側 = カッ
- メニューで `.tja` と音源（ogg / mp3 / wav / m4a）を**同時に**選択。音源は `WAVE:` の名前と一致するものを優先します
- 「デモ譜面で遊ぶ」で曲なしの動作確認ができます

## 開発

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # パーサ・判定のテスト
npm run build   # dist/ に出力
```

## GitHub Pages で公開

1. このフォルダを GitHub リポジトリに push
2. リポジトリの **Settings → Pages → Source** を **GitHub Actions** にする
3. `main` に push するたびに `.github/workflows/deploy.yml` がテスト → ビルド → 公開します

## 構成

```
src/
  chart/    types.ts（共通譜面形式） tja.ts（TJAパーサ） decode.ts（Shift_JIS対応）
  engine/   game.ts（判定・スコア・コンボ。描画から独立）
  render/   renderer.ts（Canvas描画）
  audio/    audio.ts（Web Audio。曲の再生位置をゲーム時刻に使う）
  input.ts  キーボード / タッチ
  main.ts   メニュー・ゲームループ
```

## 対応している TJA 命令

`TITLE` `SUBTITLE` `BPM` `OFFSET` `WAVE` `COURSE` `LEVEL` `BALLOON`
`#START` `#END` `#BPMCHANGE` `#SCROLL` `#MEASURE` `#DELAY` `#GOGOSTART` `#GOGOEND` `#BARLINEON` `#BARLINEOFF`

譜面分岐（`#BRANCHSTART` 等）は現状「普通譜面（#N）」だけを読みます。

## 判定幅

| 判定 | 幅 |
| --- | --- |
| 良 | ±35ms |
| 可 | ±90ms |
| 不可 | ±120ms |

`src/engine/game.ts` の `WINDOW` で変更できます。

## ロードマップ

- [ ] 選曲画面（フォルダ読み込み・プレビュー再生）
- [ ] Malody `.mc` 譜面のインポート
- [ ] 譜面分岐
- [ ] 大音符の両手判定
- [ ] スキン・効果音の差し替え
- [ ] PWA 化（オフライン対応）

## 注意

既存の商用タイトルの名称・画像・効果音・公式譜面は同梱しないでください。
素材はオリジナルかライセンス上問題のないものを使用してください。
