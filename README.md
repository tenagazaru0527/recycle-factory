# recycle-factory

12分ランで投資判断とボトルネック解消を行う自動化リサイクル工場ゲームです。
設計仕様の正本は [docs/design.md](docs/design.md) を参照してください（本 README は手順のみを扱い、ゲームルールや数値は設計書を参照します）。

## 必要環境

- Node.js 22（CI と同じ）
- 依存パッケージはありません（`npm install` は不要）

## 起動方法

ブラウザで動く静的ページで、サーバーは不要です。

- `index.html` をブラウザで直接開く

ローカルサーバー経由で開きたい場合:

```bash
python3 -m http.server 8000
# ブラウザで http://localhost:8000/ を開く
```

デバッグ UI から「開始 / 停止 / 10秒進める / リセット」を操作できます。

## テスト実行

game-core のユニットテストを実行します。

```bash
npm test
```

## シミュレータ実行

戦略・ラウンド補正・バッファ容量を掃引し、指標を JSON に出力します。

```bash
npm run sim:log
```

結果は `logs/simulation-results.json` に書き出されます（`logs/` は Git 管理外）。
