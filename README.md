
# 2D 学級総合

グループごとの提出期限、完了報告、外出予定を管理する学校ポータルです。

## ローカルで起動

1. Node.jsをインストールします。
2. プロジェクト直下の`.env.example`を`.env`にコピーし、SupabaseのURL、service role key、総合係用パスワードを設定します。
3. `npm install`を実行します。
4. `npm start`を実行し、`http://localhost:4173`を開きます。

## Supabaseに公開

SupabaseはデータベースとAPIを担当します。ブラウザー画面はGitHub Pagesで公開し、Supabase Storageには配置しません。Node.jsの開発サーバーはSupabaseにデプロイしません。

1. 新規DBではSupabase SQL Editorで[`supabase/schema.sql`](./supabase/schema.sql)を実行します。すでにアプリのDBがある場合は、追加認証テーブルだけを作る[`supabase/edge-auth-migration.sql`](./supabase/edge-auth-migration.sql)を実行します。
2. Supabase CLIでログインし、プロジェクトにリンクします。

   ```sh
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   ```

3. Edge Functionに`.env`の秘密設定を登録して、APIをデプロイします。

   ```sh
   npx supabase secrets set --env-file .env
   npx supabase functions deploy sogo --use-api
   ```

4. GitHub Pagesは`main`へのpushで更新されます。公開URLは[`https://ido-sogo.github.io/sogo/`](https://ido-sogo.github.io/sogo/)です。

`.env`はGitHubへコミットしないでください。GitHub PagesからSupabase APIへの通信は、`ido-sogo.github.io`だけを許可しています。
