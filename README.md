# Malody Web Editor（太鼓譜面エディタ）

ブラウザで動く、Malody 風の太鼓譜面（TJA）エディタです。スマホでもPCでも使えます。
作った譜面はその場でテストプレイできます。

## 使い方

### 開く・保存
- **☰ → .tja / .zip を開く**: `.tja` と音源を一緒に選ぶか、まとめた `.zip` を選択（中の `WAVE:` に合う音源を自動で組み合わせます）
- **音源を差し替え**: 新規作成した譜面に曲を付けるとき
- **.tja を保存 / .zip（譜面＋音源）**: 書き出し。`.tja` は UTF-8（BOM付き）
- 編集内容（譜面・音源）はブラウザ内に**自動保存**され、次に開いたときに復元されます

### 編集画面
- 時間は**下から上**へ流れます。黄色い線が現在位置（再生位置）
- **ドラッグ**でスクロール、**2本指ピンチ**または −/＋ で拡大縮小
- 下のツールを選んで**タップで配置**。同じノーツをもう一度タップで削除、別の色なら置き換え
- **連打・風船**: 始点 → 終点の順にタップ。風船を風船ツールでタップすると打数を変更
- **分割**: 1拍を何等分してスナップするか（1/1〜1/32）
- **▶**: 再生（打音・メトロノームあり）。`1.0x` を押すと 0.75 / 0.5 / 0.25 倍速
- **イベント**: 現在位置に BPM変更・SCROLL・拍子・GOGO・小節線・DELAY を追加／一覧から移動・削除
- **情報**: タイトル・BPM・OFFSET（±10ms 調整ボタンあり）、難易度の追加・複製・削除、テストプレイ設定
- **テスト**: 現在位置からテストプレイ（タッチ: 太鼓の内側＝ドン／外側＝カッ、キー: F J＝ドン D K＝カッ）

### PC のショートカット
| キー | 動作 |
| --- | --- |
| Space | 再生 / 停止 |
| 1〜7 / 0・E | ドン・カッ・大ドン・大カッ・連打・大連打・風船 / 消去 |
| ↑ ↓ | 1グリッド移動 |
| PageUp / PageDown | 1小節移動 |
| Ctrl+Z / Ctrl+Y | 元に戻す / やり直し |
| Ctrl+ホイール, − ＝ | 拡大縮小 |

## 開発

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # パーサ・書き出し・zip・判定のテスト
npm run build   # dist/ に出力
```

`main` に push すると GitHub Actions がテスト → ビルド → GitHub Pages へ公開します
（Settings → Pages → Source を「GitHub Actions」に）。

## 構成

```
src/
  chart/    model.ts（編集用の拍ベース譜面・時間変換） tja.ts（読み込み） tjaWrite.ts（書き出し）
            types.ts（プレイ用の秒ベース譜面） decode.ts（Shift_JIS 対応）
  editor/   editor.ts（編集操作・Undo/Redo） view.ts（縦スクロール画面・タッチ操作）
  io/       zip.ts（依存なしの zip 読み書き） load.ts（ファイル読み込み） storage.ts（自動保存）
  play/     playmode.ts（テストプレイ）
  engine/   game.ts（判定・スコア）
  render/   renderer.ts（テストプレイの描画）
  audio/    audio.ts（Web Audio）
  main.ts   画面の組み立て
```

譜面は内部では「秒」ではなく **tick（1拍 = 6720）** で持っています。BPM や OFFSET を後から変えても、ノーツが拍からずれません。

## 対応している TJA

`TITLE` `SUBTITLE` `BPM` `OFFSET` `WAVE` `DEMOSTART` `COURSE` `LEVEL` `BALLOON`（他のヘッダは保持して書き出し）
`#START` `#END` `#BPMCHANGE` `#SCROLL` `#MEASURE` `#DELAY` `#GOGOSTART` `#GOGOEND` `#BARLINEON` `#BARLINEOFF`

譜面分岐は現状「普通譜面（#N）」だけを読み込みます。

## 既知の制限

- iPhone / iPad の Safari は `.ogg` を再生できないことがあります。その場合は mp3 / m4a に変換してください
- 範囲選択・コピー＆ペースト、譜面分岐の編集、Malody 形式（.mc / .mcz）の読み書きは未対応

## 注意

既存の商用タイトルの名称・画像・効果音・公式譜面は同梱しないでください。
