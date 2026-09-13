# livepocket-qr-ocr-test

QRコード読み取り + OCR(整理番号・チケット番号・申込番号の自動抽出)の精度・速度検証用アプリ。
本番の `livepocket-qr-checker` とは完全に別のリポジトリ・別のFirebaseプロジェクトです。

## 画面構成

- スマートフォン: カメラでQRを読み取り → 読み取った瞬間の映像フレームをOCR(最大約1.2秒) → 結果をFirestoreに保存
- PC: リアルタイムのスキャンログ(QRの内容 + 整理番号 + チケット番号 + 申込番号)を表示

## セットアップ手順

1. このZIPを展開し、リポジトリのルートに `rsync -av` で反映してください(手順は別途チャットでご案内した内容と同じです)。
2. GitHubリポジトリの `Settings > Secrets and variables > Actions` で、以下6つのSecretsを登録してください(Firebaseプロジェクト設定画面からコピーした値)。
   - `FIREBASE_API_KEY`
   - `FIREBASE_AUTH_DOMAIN`
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_STORAGE_BUCKET`
   - `FIREBASE_MESSAGING_SENDER_ID`
   - `FIREBASE_APP_ID`
3. GitHubリポジトリの `Settings > Pages` で、Source を「GitHub Actions」に設定してください。
4. Firebase Consoleの対象プロジェクトで `Firestore Database > ルール` を開き、このリポジトリ内の `firestore.rules` の内容を貼り付けて「公開」してください。
5. `git add` → `commit` → `push` すると、GitHub Actionsが自動でビルド・デプロイします(数分後に `https://pirocchi2001.github.io/livepocket-qr-ocr-test/` で確認できます)。

## 注意点

- 今回はテスト用のため、認証・重複防止・Excel出力・全リセット機能は含めていません。
- OCRで認識できなかった項目は空欄になります(スキャン自体は失敗せず継続します)。
