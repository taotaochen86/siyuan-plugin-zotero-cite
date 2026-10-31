#!/usr/bin/env bash
# 打包为集市要求的 package.zip。
# 关键：文件必须直接位于 zip 根层，不能套一层目录，否则集市安装后的目录结构是错的。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v zip >/dev/null 2>&1 || { echo "未找到 zip 命令" >&2; exit 1; }

NAME="$(node -p "require('./plugin.json').name")"
VER="$(node -p "require('./plugin.json').version")"
OUT="package.zip"

# 集市校验会看这几样，缺一个都不行
FILES=(index.js index.css plugin.json icon.png)

# README 按 plugin.json 里声明的语言逐个带进去（去重）
while IFS= read -r f; do
    [ -n "$f" ] && FILES+=("$f")
done < <(node -e "const r=require('./plugin.json').readme||{};console.log([...new Set(Object.values(r))].join('\n'))")

[ -f icon.svg ] && FILES+=(icon.svg)
[ -f LICENSE ] && FILES+=(LICENSE)
[ -d i18n ] && FILES+=(i18n)

for f in "${FILES[@]}"; do
    [ -e "$f" ] || { echo "缺少文件: $f" >&2; exit 1; }
done

rm -f "$OUT"
zip -qr -X "$OUT" "${FILES[@]}" -x '*.DS_Store' '*/.*'

echo "已生成 $OUT  ($(stat -c %s "$OUT" 2>/dev/null || stat -f %z "$OUT") 字节)  ${NAME} v${VER}"
unzip -l "$OUT"
