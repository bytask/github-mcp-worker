# github-mcp-worker

github-mcp の公開版（MIT）。利用者が自分の Cloudflare account に出す。

## 開発フロー（tskf `01-operations/playbooks/infra/dev-flow.md`）

- **git 方針**: `pr` — `tskf/<項目 id>` ブランチ → PR → CI が緑なら自分で squash merge（`gh pr checks <PR> --watch --fail-fast && gh pr merge <PR> --squash --delete-branch`。tskf BDR-0024。1 人運用でレビュー相手がいない）
- **デプロイ**: 無い（利用者が自分の account で `npm run deploy`）。社内版は `bytask/github-mcp`
- **本番デプロイは承認ゲートで止める**（まだ自動化していない）
