#!/bin/bash
# Phrontis Linux postinst（deb 专用）—— 2026-10-19 Linux 平台化阶段 2
#
# 为什么整份替换 electron-builder 的默认 after-install 模板（不是追加）：
#   `build.deb.afterInstall` 一旦给定就**取代**默认模板（见 app-builder-lib 的 FpmTarget.createScripts），
#   所以默认行为必须在这里原样重述，再叠加一道兜底。
#
# 兜底要解决的故障（已在本机核实）：
#   Ubuntu 24+ 用 AppArmor 限制了非特权 user namespace（kernel.apparmor_restrict_unprivileged_userns=1），
#   而默认模板的判据只有 `unshare --user true` —— 本机该测试**通过**，于是走 chmod 0755 分支，
#   沙箱全指望 `/opt/Phrontis/resources/apparmor-profile` 被装进 /etc/apparmor.d。
#   若本机 AppArmor 拒绝随包 profile（abi/4.0 不支持 / 服务被停用 / 容器里），两条防线同时落空 →
#   Chromium 起手就 FATAL：SUID sandbox helper binary was found, but is not configured correctly。
#   本脚本因此把「profile 是否真的装成」记下来，装不成且内核限制 userns 时回退 chmod 4755。
#
# ★ 本文件会被 electron-builder 做宏替换（正则 /\$\{([a-zA-Z]+)\}/），未定义的宏直接抛错 →
#   shell 变量**一律用 $VAR 写法，禁止写花括号形式**（默认模板同样遵守这一点）。
#   可用宏：executable / sanitizedProductName / productFilename。

# 1) /usr/bin/<executable> → /opt/<product>/<executable>（保留默认模板的 update-alternatives 逻辑）
if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# 2) 内核是否支持非特权 user namespace（与默认模板同判据）
SUID_NEEDED=0
if ! { [ -L /proc/self/ns/user ] && unshare --user true; }; then
    SUID_NEEDED=1
fi

# 3) AppArmor profile（Ubuntu 24+）：先做一次 parse 干跑，能接受才装
AA_INSTALLED=0
if apparmor_status --enabled > /dev/null 2>&1; then
    AA_SRC='/opt/${sanitizedProductName}/resources/apparmor-profile'
    AA_DST='/etc/apparmor.d/${executable}'
    if apparmor_parser --skip-kernel-load --debug "$AA_SRC" > /dev/null 2>&1; then
        cp -f "$AA_SRC" "$AA_DST"
        # chroot 里 live 加载没有意义（dh_apparmor 同款判断）
        if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
            apparmor_parser --replace --write-cache --skip-read-cache "$AA_DST" || true
        fi
        AA_INSTALLED=1
    else
        echo "Phrontis: 本机 AppArmor 不支持随包 profile（abi/4.0），跳过安装"
    fi
fi

# 4) chrome-sandbox 权限：profile 装成 → 0755（沙箱由 profile 放行）
#    否则只要「内核限制 userns」或「内核不支持 userns」→ 4755（SUID helper 兜底）
RESTRICT_USerns=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)
if [ "$AA_INSTALLED" = "1" ]; then
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
elif [ "$SUID_NEEDED" = "1" ] || [ "$RESTRICT_USerns" = "1" ]; then
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
    echo "Phrontis: 未安装 AppArmor profile，已把 chrome-sandbox 回退为 4755 以保证可启动"
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

# 5) 桌面集成（阶段 1）：D-Bus 激活服务 + CLI
#    - .service 让「应用没开时，面板/扩展里的打卡」能把应用拉起来（总线激活）；
#    - /usr/bin/phrontis-cli 是终端入口；/usr/bin/<executable> 仍是 GUI 链接，不动。
#    Exec 行在这里按宏重写，避免产品名变化后服务文件指向不存在的路径。
BRIDGE_DIR="/opt/${sanitizedProductName}/resources/desktop-bridge"
if [ -d "$BRIDGE_DIR" ]; then
    install -Dm644 "$BRIDGE_DIR/io.github.lousync.Phrontis.service" /usr/share/dbus-1/services/io.github.lousync.Phrontis.service
    sed -i "s|^Exec=.*|Exec=/opt/${sanitizedProductName}/${executable} --ozone-platform=x11|" /usr/share/dbus-1/services/io.github.lousync.Phrontis.service
    install -Dm644 "$BRIDGE_DIR/phrontis.cjs" /usr/lib/phrontis/phrontis.cjs
    install -Dm755 "$BRIDGE_DIR/phrontis-cli" /usr/bin/phrontis-cli
fi

# 6) 桌面 / MIME 数据库刷新（与默认模板一致）
if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

exit 0
