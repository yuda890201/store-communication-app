# store-communication-app

店舗内コミュニケーション専用アプリ（`index.html` 単体の静的アプリ + Firebase）。ホーム画面のカードから各機能を開く形式です。

## 機能

- **📝 連絡ノート**: 日々の申し送り事項をタイムライン形式で投稿・共有
- **📌 掲示板**: お知らせを投稿し、重要なものはピン留めで先頭固定。投稿ごとに「要確認」を設定すると、スタッフは手書きサインで既読を記録します（チェックボックスだけの形骸化した既読確認を防ぐため）
- **📖 マニュアル**: カテゴリ別に業務手順書を登録し、折りたたみ表示で閲覧
- **💬 チャットルーム**: スタッフ間でリアルタイムにメッセージをやり取り
- **🎒 忘れ物管理台帳**: 拾得物を写真付きで記録し、保管中・返却済み・廃棄済みのステータスを管理
- **🎓 トレーニング管理（名称変更可）**: 研修・資格制度のステップを登録し、完了時に本人が手書きサインして進捗を記録。機能名は店舗ごとに⚙️設定から自由に変更できます（コード上に固有の制度名は含まれません。実際の名称や内容はご自身のFirebaseデータにのみ保存されます）
- **🧾 店控え書類の保管**: レシートなど毎日発生する書類をカメラで撮影、またはファイルから選択して保管。**この機能だけはFirebaseを使わず、端末（ブラウザ）内のIndexedDBにのみ保存**され、他の端末やクラウドには一切送信されません。日付ごとに一覧表示され、個別ダウンロードのほか、期間を指定してZIPでまとめてバックアップダウンロードできます
- **🔐 管理者チャット**: 管理者とスタッフ本人の1:1チャット。他の機能と違い匿名端末では開けず、**スタッフ本人がメールアドレス＋パスワードでログインした場合のみ**、自分のスレッドが開きます。画像・ファイルの添付にも対応（最大20MB）。⚙️設定に登録したメールアドレスでログインした人は「管理者」として全スタッフのスレッド一覧（受信箱）から選んで返信できます。スタッフの初回登録はアプリ内の「初回登録」フォームから、管理者が発行した招待コードを使って行います
  - **📹 ビデオ通話（リモート店長対応）**: 管理者チャットのスレッド内から「ビデオ通話を発信」でスタッフ⇔管理者間のビデオ通話ができます。ブラウザ標準のWebRTCによるP2P通話で、発信・応答のやり取り（シグナリング）は管理者チャットと同じFirestoreを使うため追加のサーバーは不要です。**完全無料枠のプロトタイプとして、STUNサーバーのみを使いTURN中継サーバーは組み込んでいません** — 双方とも一般的なWi-Fi/モバイル回線であれば繋がりますが、企業ネットワークや一部の閉域網など厳しいNAT環境では接続できないことがあります。管理者が呼び出しを受け取るには、アプリのタブを開いてログインした状態を保っている必要があります（プッシュ通知は今回のプロトタイプには含まれていません）

上記のうち「店控え書類の保管」を除く機能は、Firestore・Firebase Storageで店舗の端末間・スタッフ間にリアルタイムに共有されます（要Firebase接続）。「店控え書類の保管」は端末ローカル保存のため、端末の故障・初期化に備えて定期的なZIPバックアップを推奨します。「🔐 管理者チャット」のみ、他の機能とは別に本人のFirebaseアカウントでのログインが必要です。

## セットアップ

### 1. Firebaseプロジェクトの準備

1. [Firebaseコンソール](https://console.firebase.google.com/)で新規プロジェクトを作成
2. 「Firestore Database」を作成（本番モードでOK）
3. 「Storage」を作成（忘れ物の写真・管理者チャットの添付ファイルのアップロードに使用）
4. 「Authentication」→「Sign-in method」で以下の2つのプロバイダを有効化
   - **匿名（Anonymous）**: 連絡ノート・掲示板・マニュアル・チャット・忘れ物・トレーニング管理で使用。ログイン画面は表示されず、端末がバックグラウンドで自動的に匿名認証されます。
   - **メール / パスワード**: 🔐管理者チャットのスタッフ本人ログイン・自己登録に使用
5. Firestoreの「ルール」を以下のように設定

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       function isSignedIn() { return request.auth != null; }
       function isAnonymous() { return request.auth.token.firebase.sign_in_provider == 'anonymous'; }
       function isAdminEmail() {
         return isSignedIn() && !isAnonymous() &&
           exists(/databases/$(database)/documents/appSettings/general) &&
           (request.auth.token.email.lower() in
             get(/databases/$(database)/documents/appSettings/general).data.adminEmails);
       }

       // 連絡ノート・掲示板・マニュアル・チャット・忘れ物・トレーニング管理・アプリ設定
       // (匿名端末を含む全ログイン済み端末で共有)
       match /notebookEntries/{id} { allow read, write: if isSignedIn(); }
       match /bulletinPosts/{id} { allow read, write: if isSignedIn(); }
       match /bulletinAcks/{id} { allow read, write: if isSignedIn(); }
       match /manuals/{id} { allow read, write: if isSignedIn(); }
       match /chatMessages/{id} { allow read, write: if isSignedIn(); }
       match /lostItems/{id} { allow read, write: if isSignedIn(); }
       match /trainingSteps/{id} { allow read, write: if isSignedIn(); }
       match /trainingCompletions/{id} { allow read, write: if isSignedIn(); }
       match /appSettings/{id} { allow read, write: if isSignedIn(); }

       // 管理者チャット用: 本人のプロフィール (自分のuidの行だけ本人が作成・更新可)
       match /staffProfiles/{uid} {
         allow read: if isSignedIn();
         allow create, update: if isSignedIn() && !isAnonymous() && request.auth.uid == uid;
       }

       // 管理者チャット用: 本人のスレッドのみ本人が、全スレッドは管理者メールのみ閲覧・返信可
       match /dmChannels/{staffUid} {
         allow read, write: if isSignedIn() && !isAnonymous() &&
           (request.auth.uid == staffUid || isAdminEmail());

         match /messages/{msgId} {
           allow read: if isSignedIn() && !isAnonymous() &&
             (request.auth.uid == staffUid || isAdminEmail());
           allow create: if isSignedIn() && !isAnonymous() &&
             (request.auth.uid == staffUid || isAdminEmail()) &&
             request.resource.data.senderUid == request.auth.uid;
           allow update, delete: if false;
         }

         // ビデオ通話のシグナリング (発信・応答・ICE候補のやり取り)
         match /calls/{callId} {
           allow read, create, update: if isSignedIn() && !isAnonymous() &&
             (request.auth.uid == staffUid || isAdminEmail());
           allow delete: if false;

           match /callerCandidates/{cid} {
             allow read, create: if isSignedIn() && !isAnonymous() &&
               (request.auth.uid == staffUid || isAdminEmail());
             allow update, delete: if false;
           }
           match /calleeCandidates/{cid} {
             allow read, create: if isSignedIn() && !isAnonymous() &&
               (request.auth.uid == staffUid || isAdminEmail());
             allow update, delete: if false;
           }
         }
       }
     }
   }
   ```

   `isAdminEmail()` は ⚙️設定の「管理者チャット設定」に登録したメールアドレス一覧（`appSettings/general.adminEmails`）と、ログイン中のメールアドレスを比較しています。管理者を追加・削除したい場合はアプリ側の設定画面から変更でき、Firebaseコンソールでルールを書き換える必要はありません。

   > 管理者は自分宛ての着信を全スタッフ分まとめて検知するために `calls` コレクショングループに対してクエリしますが、上記ルールは各ドキュメントの実際のパス（`dmChannels/{staffUid}/calls/{callId}`）に対して個別に評価されるため、コレクショングループクエリでも同じ権限がそのまま適用されます。Firestoreの単一フィールドインデックスは自動作成されるため、このクエリのために手動でインデックスを作成する必要はありません。

   > 同じ内容はリポジトリの [`firestore.rules`](./firestore.rules) にも入っています。手動でコンソールに貼り付ける代わりに、下記「Firestore/Storageルールの自動デプロイ」の設定をしておけば、このファイルを編集してpushするだけで自動反映されます。

6. Storageの「ルール」を以下のように設定（匿名認証・メール認証を問わず、ログイン済み端末のみ読み書き許可）

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

   > **注記**: `getDownloadURL()` が返すURLはアクセストークン付きの直リンクのため、そのURL自体が漏えいすると認証なしで閲覧できてしまいます（忘れ物の写真・管理者チャットの添付ファイル共通の制約です）。URLはFirestore側のドキュメント（アクセス制御あり）にのみ保存され、アプリ外に表示・共有はしていません。

   > 同じ内容はリポジトリの [`storage.rules`](./storage.rules) にも入っています。

7. 「プロジェクトの設定」→「マイアプリ」でウェブアプリを追加し、表示される `firebaseConfig` オブジェクトをコピー

### 2. アプリ側でFirebaseに接続

`index.html` をブラウザで開き、右上の ⚙️ から「🔥 Firebaseデータベース設定」を開いて、手順1でコピーした `firebaseConfig` をJSONとして貼り付けて保存してください。

同じ ⚙️ メニューから、投稿者名・サインの記名に使う「あなたの名前」も設定してください（共有端末の場合は、使う人が変わるたびに更新してください）。

トレーニング機能の名称（店舗独自の制度名など）も ⚙️ メニューから変更できます。この設定はFirebase上に保存され、同じ店舗の全端末に共有されます。

これで店舗のタブレット（認証なし・共有利用）から、連絡ノート・掲示板・マニュアル・チャット・忘れ物・トレーニング管理がスタッフ間でリアルタイムに共有されるようになります。

### 3. 🔐管理者チャットの設定（本人認証）

1. ⚙️メニューの「管理者チャット設定」で、管理者にしたい人のメールアドレスを1行ずつ登録し、招待コード（第三者に推測されにくいもの）を設定します
2. スタッフには招待コードを口頭・メモなどで伝えてください
3. 各スタッフ（管理者になる人も含む）は、ホーム画面の「🔐管理者チャット」→「初回登録」から、名前・メールアドレス・パスワード・招待コードを入力して自分のアカウントを作成します
4. 登録したメールアドレスが手順1の管理者一覧に含まれていれば、そのアカウントでログインしたときだけ全スタッフのスレッド一覧（受信箱）が表示されます。含まれていなければ、自分自身と管理者だけが見られる個人スレッドが表示されます
5. ログアウトすると、端末は自動的に元の匿名認証に戻り、他の機能は共有端末として引き続き使えます

管理者を増やしたい・入れ替えたい場合も、Firebaseコンソールを操作する必要はなく、⚙️設定の管理者メールアドレス一覧を編集するだけで反映されます。

### 4. 📹ビデオ通話（リモート店長対応）を使う

1. 管理者チャットのスレッドを開いた状態（スタッフなら自分のスレッド、管理者ならスタッフを選んで開いたスレッド）で「📹 ビデオ通話を発信」を押すと、相手が同じ機能を開いていなくても着信が届きます（管理者はどのスタッフから発信されても着信バナーが表示されます）
2. 相手が「応答する」を押すとカメラ・マイクへのアクセス許可が求められ、許可すると通話が始まります
3. 通話中は 🎤（ミュート）・📷（カメラのON/OFF）・📞（終了）が操作できます
4. ブラウザには HTTPS（または `localhost`）でアクセスしている必要があります（カメラ・マイクの利用に必須のブラウザ制約です）。GitHub PagesやFirebase Hostingなど、通常の静的ホスティングは標準でHTTPSなので問題ありません
5. TURN中継サーバーを使わない構成のため、双方が同じような一般的なネットワーク（自宅Wi-Fi・モバイル回線など）にいれば繋がりますが、厳しいファイアウォール環境では接続できないことがあります。安定運用したくなった場合は、有料のTURNサービス（Twilioなど）か自前のcoturnサーバーの追加をご検討ください

## ホスティング（GitHub Pagesへの自動デプロイ）

`index.html` は単体の静的ファイルなので、Firebase Hosting・GitHub Pages・Netlifyなど任意の静的ホスティングにそのまま配置できます。

このリポジトリには `.github/workflows/deploy-pages.yml` を同梱しており、`main` ブランチにpushするたびに自動でGitHub Pagesへデプロイされます（ビルド不要、リポジトリのファイルをそのまま公開）。有効にするには、リポジトリの管理者権限が必要な設定を1回だけ行ってください（これはGitHub Appの権限では変更できないため、リポジトリオーナーの方の操作が必要です）。

1. GitHubの当リポジトリで **Settings → Pages** を開く
2. **Build and deployment → Source** を `Deploy from a branch` から **`GitHub Actions`** に変更する
3. `main` ブランチにpush（または `Actions` タブから `Deploy to GitHub Pages` ワークフローを手動実行）すると数十秒でデプロイされ、`https://<ユーザー名>.github.io/store-communication-app/` で公開されます

以降は `main` にpushするだけで自動的に最新版が反映されます。デプロイ状況は `Actions` タブから確認できます。

## Firestore/Storageルールの自動デプロイ（任意）

`firestore.rules`・`storage.rules` を編集してpushするだけで、Firebaseコンソールを開かずにルールを反映できるようにする設定です。必須ではありません（手動でコンソールに貼り付ける運用のままでも問題ありません）が、今後ルールを改修する機会が多い場合はおすすめです。

### 1. サービスアカウントの秘密鍵を発行（Firebaseコンソール）

1. 対象のFirebaseプロジェクトで「プロジェクトの設定」→「サービスアカウント」タブを開く
2. 「新しい秘密鍵の生成」をクリックし、JSONファイルをダウンロードする
3. ⚠️ **このJSONファイルの中身（秘密鍵）は誰にも共有しないでください**（Claudeとのチャットにも貼らないでください）。手順4で使うのはファイルの中身そのものです

### 2. Google Cloud ConsoleでIAM権限を付与

1. `https://console.cloud.google.com/iam-admin/iam?project={プロジェクトID}` を開く（`{プロジェクトID}` は自分のFirebaseプロジェクトIDに置き換え）
2. 手順1でダウンロードしたJSON内の `client_email` の値（例: `firebase-adminsdk-fbsvc@xxxx.iam.gserviceaccount.com`）を一覧から探す。あれば鉛筆アイコンで編集、なければ「+ アクセスを許可」で新規入力
3. 以下の3つのロールを付与して保存
   - **Firebase Rules Admin** (`roles/firebaserules.admin`) — FirestoreルールとStorageルールは同じ「Firebase Rules」APIの管轄なので、これ1つで両方のルール自体のデプロイをカバーします
   - **Service Usage Consumer** (`roles/serviceusage.serviceUsageConsumer`) — 近年のfirebase-toolsではサービスアカウントでのデプロイに必須です
   - **Firebase Storage Admin** (`roles/firebasestorage.admin`) — Storageルールのデプロイ前に、firebase-toolsがプロジェクトのデフォルトバケット名を参照する（`firebasestorage.defaultBucket.get`）ために必要です。これが無いと `Permission 'firebasestorage.defaultBucket.get' denied` というエラーでStorageルールのデプロイだけ失敗します（Firestoreルールは成功します）

### 3. GitHubリポジトリにシークレットを登録

1. リポジトリの **Settings → Secrets and variables → Actions** → 「New repository secret」
2. Name: `FIREBASE_SERVICE_ACCOUNT`
3. Value: 手順1でダウンロードしたJSONファイルの中身をまるごと貼り付け（このJSONはClaudeとのチャットを経由せず、GitHubの画面に直接貼ってください）

プロジェクトIDはこのJSON内の `project_id` からワークフローが自動的に読み取るため、別途シークレットを登録する必要はありません。

登録が完了すると、`.github/workflows/deploy-firebase-rules.yml` により、`firestore.rules`・`storage.rules`・`firebase.json` のいずれかを変更してpushするたびに自動でFirebaseへデプロイされます。`Actions` タブから手動実行（`workflow_dispatch`）することも可能です。
