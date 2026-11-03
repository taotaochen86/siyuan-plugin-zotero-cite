#!/usr/bin/env bash
# 发版前体检：任何一项不过就不该发。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAIL=0
ok()   { echo "  ok   $*"; }
bad()  { echo "  FAIL $*"; FAIL=$((FAIL + 1)); }

echo "== 1. 清单与元数据 =="
if ! node -e "JSON.parse(require('fs').readFileSync('plugin.json','utf8'))" 2>/dev/null; then
    bad "plugin.json 不是合法 JSON"
else
    ok "plugin.json 可解析"
fi
if ! node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" 2>/dev/null; then
    bad "package.json 不是合法 JSON"
else
    ok "package.json 可解析"
fi

NAME="$(node -p "require('./plugin.json').name" 2>/dev/null || echo '')"
VER="$(node -p "require('./plugin.json').version" 2>/dev/null || echo '')"
PVER="$(node -p "require('./package.json').version" 2>/dev/null || echo '')"
URL="$(node -p "require('./plugin.json').url" 2>/dev/null || echo '')"
RURL="$(node -p "require('./package.json').repository.url" 2>/dev/null || echo '')"

[ "$NAME" = "siyuan-plugin-zotero-cite" ] && ok "name = $NAME" || bad "name 不符：$NAME"
[ -n "$VER" ] && ok "plugin.json version = $VER" || bad "缺 version"
[ "$VER" = "$PVER" ] && ok "package.json version 与之一致" || bad "版本不一致：plugin=$VER package=$PVER"

echo "== 2. 仓库地址与占位符 =="
if printf '%s' "$URL" | grep -qi "wish5115\|^$\|TODO\|example"; then
    bad "url 仍是占位或为空：$URL"
else
    ok "url = $URL"
fi
if [ "${RURL%.git}" = "$URL" ]; then
    ok "package.json repository 与 plugin.json url 一致"
else
    bad "repository 不一致：$RURL vs $URL"
fi

echo "== 3. 代码语法 =="
if node --check index.js 2>/dev/null; then ok "index.js 语法通过"; else bad "index.js 语法错误"; fi

echo "== 4. 必需文件 =="
for f in index.js index.css plugin.json icon.png README.md; do
    [ -s "$f" ] && ok "$f" || bad "缺少或为空：$f"
done
for f in i18n/zh_CN.json i18n/en_US.json; do
    if node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" 2>/dev/null; then
        ok "$f 可解析"
    else
        bad "$f 缺失或非法"
    fi
done

# plugin.json 里声明的每个 readme 文件都必须真实存在，否则集市卡片会空着
while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ -s "$f" ] && ok "readme $f" || bad "readme 声明的文件缺失：$f"
done < <(node -e "const r=require('./plugin.json').readme||{};console.log([...new Set(Object.values(r))].join('\n'))")

echo "== 5. 图标规格 =="
node -e '
const fs = require("fs");
const b = fs.readFileSync("icon.png");
if (b.slice(1, 4).toString() !== "PNG") { console.log("  FAIL icon.png 不是 PNG"); process.exit(1); }
const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
if (w < 256 || h < 256) { console.log(`  FAIL icon.png 只有 ${w}x${h}，集市建议 256x256`); process.exit(1); }
console.log(`  ok   icon.png ${w}x${h}`);
' || FAIL=$((FAIL + 1))

echo "== 5b. 集市封面体积（上限 512 KB） =="
node -e '
const fs = require("fs");
if (!fs.existsSync("preview.png")) { console.log("  warn 没有 preview.png，集市详情页顶部会空白"); process.exit(0); }
const b = fs.readFileSync("preview.png");
if (b.slice(1, 4).toString() !== "PNG") { console.log("  FAIL preview.png 不是 PNG"); process.exit(1); }
const kb = b.length / 1024;
const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
if (kb > 512) { console.log(`  FAIL preview.png ${kb.toFixed(1)}KB 超过集市 512KB 上限（${w}x${h}）`); process.exit(1); }
console.log(`  ok   preview.png ${w}x${h} ${kb.toFixed(1)}KB`);
' || FAIL=$((FAIL + 1))

echo "== 6. package.zip 结构（若已构建） =="
if [ -f package.zip ]; then
    if unzip -l package.zip | awk 'NR>3 && $4 != "" {print $4}' | grep -q "^[^/]*/$"; then
        bad "package.zip 里存在顶层目录，集市安装会错位"
    else
        ok "package.zip 根层为文件，结构正确"
    fi
    unzip -l package.zip | grep -q "plugin.json" && ok "包含 plugin.json" || bad "缺少 plugin.json"
    unzip -l package.zip | grep -q "index.js" && ok "包含 index.js" || bad "缺少 index.js"
else
    echo "  --   尚未构建 package.zip，跳过"
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "体检通过，可以发版。"
    exit 0
else
    echo "体检未通过：$FAIL 项问题。"
    exit 1
fi
