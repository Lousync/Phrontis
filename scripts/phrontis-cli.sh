#!/bin/sh
# dev 环境的 CLI 入口（不进安装包）：
#   ./scripts/phrontis-cli.sh today
#
# dev 的总线名默认走 .Dev 后缀，避免和已安装的正式版抢同一个名字。
# 需要连正式版时：PHRONTIS_BUS_NAME=io.github.lousync.Phrontis ./scripts/phrontis-cli.sh today

set -e
cd "$(dirname "$0")/.." || exit 1
: "${PHRONTIS_BUS_NAME:=io.github.lousync.Phrontis.Dev}"
export PHRONTIS_BUS_NAME
exec node scripts/desktop-bridge/phrontis.cjs "$@"
