# store-communication-app

店舗内コミュニケーション専用アプリ（`index.html` 単体の静的アプリ + Firebase）。ホーム画面のカードから各機能を開く形式です。

## 機能

- **📝 連絡ノート**: 日々の申し送り事項をタイムライン形式で投稿・共有
- **📌 掲示板**: お知らせを投稿し、重要なものはピン留めで先頭固定。投稿ごとに「要確認」を設定すると、スタッフは手書きサインで既読を記録します（チェックボックスだけの形骸化した既読確認を防ぐため）
- **📖 マニュアル**: カテゴリ別に業務手順書を登録し、折りたたみ表示で閲覧
- **💬 チャットルーム**: スタッフ間でリアルタイムにメッセージをやり取り
- **🎒 忘れ物管理台帳**: 拾得物を写真付きで記録し、保管中・返却済み・廃棄済みのステータスを管理
- **🎓 トレーニング管理（名称変更可）**: 研修・資格制度のステップを登録し、完了時に本人が手書きサインして進捗を記録。機能名は店舗ごとに⚙️設定から自由に変更できます（コード上に固有の制度名は含まれません。実際の名称や内容はご自身のFirebaseデータにのみ保存されます）

いずれの機能もFirestore・Firebase Storageで店舗の端末間・スタッフ間にリアルタイムに共有されます（要Firebase接続）。

## セットアップ

### 1. Firebaseプロジェクトの準備

1. [Firebaseコンソール](https://console.firebase.google.com/)で新規プロジェクトを作成
2. 「Firestore Database」を作成（本番モードでOK）
3. 「Storage」を作成（忘れ物の写真アップロードに使用）
4. 「Authentication」→「Sign-in method」で **匿名（Anonymous）** プロバイダを有効化
   - ログイン画面は表示されません。端末がバックグラウンドで自動的に匿名認証されます。
5. Firestoreの「ルール」を以下のように設定（匿名認証済みの端末のみ読み書き許可）

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```

6. Storageの「ルール」を以下のように設定（匿名認証済みの端末のみ読み書き許可）

   ```
   rules_version = '2';
   service firebase.storage {
     match /b/{bucket}/o {
       match /{allPaths=**} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```

7. 「プロジェクトの設定」→「マイアプリ」でウェブアプリを追加し、表示される `firebaseConfig` オブジェクトをコピー

### 2. アプリ側でFirebaseに接続

`index.html` をブラウザで開き、右上の ⚙️ から「🔥 Firebaseデータベース設定」を開いて、手順1でコピーした `firebaseConfig` をJSONとして貼り付けて保存してください。

同じ ⚙️ メニューから、投稿者名・サインの記名に使う「あなたの名前」も設定してください（共有端末の場合は、使う人が変わるたびに更新してください）。

トレーニング機能の名称（店舗独自の制度名など）も ⚙️ メニューから変更できます。この設定はFirebase上に保存され、同じ店舗の全端末に共有されます。

これで店舗のタブレット（認証なし・共有利用）から、全機能がスタッフ間でリアルタイムに共有されるようになります。

## ホスティング

`index.html` は単体の静的ファイルなので、Firebase Hosting・GitHub Pages・Netlifyなど任意の静的ホスティングにそのまま配置できます。
