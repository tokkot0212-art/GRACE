# 美容室GRACE 予約サイト

富谷市成田の完全個室サロン「美容室GRACE」の予約サイトです。`index.html` 1ファイルで動きます。

## まず書き換えるところ
`index.html` の下のほう、`const CONFIG = {` の中だけ直せばOKです。

| 項目 | 内容 |
|---|---|
| `openTime` | 開店時間（今は仮で 09:00） |
| `closedWeekdays` / `holidayText` | 定休日（今は仮で月曜） |
| `closedDates` | 臨時休業日 |
| `parking` | 駐車場の案内 |
| `menu` | メニュー名・価格・所要時間（**今は仮の価格です**） |
| `formEndpoint` / `lineUrl` / `email` | 予約の受け取り方（下記） |

## 予約の受け取り方
GitHub Pages は静的サイトなので、予約内容を受け取る先を1つ設定します。何も設定しないと「電話で予約」＋「内容をコピー」だけが出ます。

- **ネットで送信（おすすめ）**：[Formspree](https://formspree.io) で無料フォームを作り、発行されたURLを `formEndpoint` に入れる → 予約がメールで届きます。
- **LINE**：LINE公式アカウントの友だち追加URLを `lineUrl` に。
- **メール**：受付用アドレスを `email` に。

※ 空き状況のリアルタイム表示や二重予約の自動防止はありません。届いた予約にお店から連絡して確定する流れです。

## GitHubで公開する
1. GitHubで新しいリポジトリを作る（例：`grace-salon`、Public）
2. `index.html` と `README.md` をアップロード（「Add file → Upload files」）
3. Settings → Pages → Branch を `main` / `/ (root)` にして Save
4. 数分後、`https://<ユーザー名>.github.io/grace-salon/` で公開されます。このURLをお客さんにLINEやQRコードでシェア。

コマンドで行う場合：
```bash
git init && git add . && git commit -m "GRACE予約サイト"
git branch -M main
git remote add origin https://github.com/<ユーザー名>/grace-salon.git
git push -u origin main
```
