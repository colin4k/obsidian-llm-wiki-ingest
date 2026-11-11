#!/bin/sh
# 把插件安装到 Obsidian 的插件目录。
# 默认目标 vault 可用环境变量覆盖：OBSIDIAN_VAULT=/path/to/Vault ./install.sh
set -e

VAULT="${OBSIDIAN_VAULT:-$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/ColinVault}"
DEST="$VAULT/.obsidian/plugins/llm-wiki-ingest"

if [ ! -d "$VAULT" ]; then
  echo "找不到 vault：$VAULT" >&2
  echo "用环境变量指定：OBSIDIAN_VAULT=/path/to/Vault ./install.sh" >&2
  exit 1
fi

cd "$(dirname "$0")"
node build.js

mkdir -p "$DEST"
rsync -a \
  --exclude 'node_modules' --exclude 'data.json' \
  --exclude '.git' --exclude '.DS_Store' --exclude '*.log' \
  ./ "$DEST"/
chmod +x "$DEST/install.sh" 2>/dev/null || true

echo "已安装到：$DEST"
echo "如果没有生效，重启 Obsidian 或在「设置 → 第三方插件」里重新启用。"
