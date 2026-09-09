#!/bin/sh
# 依存の脆弱性を見る。コミット前にhookから呼ばれる (.claude/settings.json)。
#
# **見つかったらコミットを止める。** pushしてGitHubに指摘されて初めて気づく、
# という流れを避けるため。判断のうえで受け入れるものは、無視せず設定に書く:
#
#   Rust : pipeline/.cargo/audit.toml の ignore に、理由と外せる条件を添えて足す
#   npm  : web/package.json の pnpm.auditConfig.ignoreCves に足す
#
# どちらも「なぜ受け入れたか」がリポジトリに残る形にすること。
set -e
cd "$(dirname "$0")/.."

status=0

echo "== web (npm) =="
# pnpm audit は見つかると非0で終わる。ここで止めずに両方見たいので拾っておく。
(cd web && mise exec -- pnpm audit) || status=1

echo
echo "== pipeline (Rust) =="
(cd pipeline && mise exec -- cargo audit) || status=1

echo
if [ "$status" -ne 0 ]; then
  echo "脆弱性が見つかりました。直すか、理由を添えて設定に記録してください。" >&2
else
  echo "脆弱性はありません。"
fi
exit "$status"
