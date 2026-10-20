#!/bin/bash
# Phrontis Linux after-remove（deb 专用）—— 桌面集成阶段 1
#
# after-install 生成的 D-Bus 服务文件 / CLI 不被 dpkg 跟踪，必须在这里清理。
# 漏清的后果：卸载后 /usr/share/dbus-1/services 里留一个指向不存在可执行文件的
# 服务文件 —— 面板/扩展的调用会报 "Failed to activate service"，且重装前一直报。
#
# ★ 升级时不能删：dpkg 的顺序是「旧 postrm upgrade → 配置新版」，
#   若无条件执行会把刚装好的新文件删掉。只在真正 remove / purge 时清理。

case "$1" in
    upgrade|failed-upgrade)
        exit 0
        ;;
esac

rm -f /usr/share/dbus-1/services/io.github.lousync.Phrontis.service
rm -f /usr/bin/phrontis-cli
rm -rf /usr/lib/phrontis

exit 0
