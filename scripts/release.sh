#!/usr/bin/env bash
# 用 GitHub API 直接发版：不需要 GitHub Actions，也不需要 workflow 权限。
# 用法：GH_TOKEN=ghp_xxx bash scripts/release.sh [发布说明.md]
# 说明文件缺省时用 plugin.json 里的中文描述。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${GH_TOKEN:?请先设置环境变量 GH_TOKEN}"
REPO="$(node -p "require('./package.json').repository.url.replace(/^.*github\.com\//,'').replace(/\.git$/,'')")"
VER="$(node -p "require('./plugin.json').version")"
TAG="v${VER}"
NOTES_FILE="${1:-}"

# 发版前体检：占位符、url 与仓库是否一致、版本号、包结构。任一不过直接退出。
if ! bash scripts/preflight.sh; then
    echo "发版中止：体检未通过（见上）。" >&2
    exit 1
fi

# 版本号忘了改会撞 422；提前问清楚
if curl -sSo /dev/null -m 30 -w "%{http_code}" \
    -H "Authorization: token ${GH_TOKEN}" \
    "https://api.github.com/repos/${REPO}/releases/tags/${TAG}" | grep -q "^200$"; then
    echo "发版中止：${TAG} 已存在。改完 plugin.json 与 package.json 的 version 再来。" >&2
    exit 1
fi

if [ -n "$NOTES_FILE" ] && [ -f "$NOTES_FILE" ]; then
    BODY="$(cat "$NOTES_FILE")"
else
    BODY="$(node -p "require('./plugin.json').description['zh_CN']")"
fi

PAYLOAD="$(BODY="$BODY" TAG="$TAG" node -e '
const p = JSON.stringify({
  tag_name: process.env.TAG,
  target_commitish: "main",
  name: process.env.TAG,
  body: process.env.BODY,
  draft: false,
  prerelease: false,
  make_latest: "true",
});
process.stdout.write(p);
')"

echo "创建 Release ${TAG} @ ${REPO}"
RESP="$(curl -sS -m 60 -X POST \
    -H "Authorization: token ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/releases" \
    -d "$PAYLOAD")"

UPLOAD="$(printf '%s' "$RESP" | node -e '
let s = "";
process.stdin.on("data", (c) => (s += c));
process.stdin.on("end", () => {
  let d;
  try { d = JSON.parse(s); } catch (e) { console.error("响应解析失败:", s.slice(0, 300)); process.exit(1); }
  if (!d.upload_url) { console.error("创建失败:", d.message || s.slice(0, 300)); process.exit(1); }
  process.stdout.write(d.upload_url.replace(/\{.*\}$/, ""));
});
')"

echo "上传 package.zip"
curl -sS -m 180 -X POST \
    -H "Authorization: token ${GH_TOKEN}" \
    -H "Content-Type: application/zip" \
    --data-binary "@package.zip" \
    "${UPLOAD}?name=package.zip&label=package.zip" \
    | node -e '
let s = "";
process.stdin.on("data", (c) => (s += c));
process.stdin.on("end", () => {
  const d = JSON.parse(s);
  if (d.state === "uploaded") console.log("已上传:", d.name, d.size, "字节");
  else { console.error("上传失败:", d.message || s.slice(0, 300)); process.exit(1); }
});
'

echo "完成：https://github.com/${REPO}/releases/tag/${TAG}"
