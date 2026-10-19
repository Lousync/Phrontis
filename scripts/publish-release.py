#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
应用安装包发布脚本（三件套完整性门）—— v2.13.0「先传 exe、后补 latest.yml/blockmap」事故的发布侧防线。

门 1：安装包 + 同名 .blockmap（仅 Windows）+ 更新元数据（latest.yml / latest-linux.yml）必须同时存在
门 2：更新元数据的 sha512(base64)/size 与本地安装包实测一致
门 3：更新元数据顶层 version 与 --version 一致
通过后 gh release 一次性原子上传三件套，并回读远端资产列表校验齐全。

---- 平台分叉（2026-10-19 · Linux 平台化阶段 2，已拍板决策 #6）----
Windows 与 Linux 用**独立 tag**（Windows `v<ver>` / Linux `v<ver>-linux`），原因：
  · 两边的「最新版本」语义不同（Linux 自 3.9.2 起才有安装包，Windows 更早）；
  · 应用内自动更新只跑 Windows（Linux 版已关掉，见 electron/lib/updateService.ts），
    若共用 tag，Linux 的 latest-linux.yml 与 Windows 的 latest.yml 会挤在同一 Release 里，
    任何一个平台的产物重传都会牵动另一个平台的更新判定。
`--platform` 缺省按**产物目录里实际存在的文件**判定（有 .deb → linux，有 -setup.exe → windows），
所以老用法 `python scripts/publish-release.py --version 3.4.1` 行为不变。

用法：
  python scripts/publish-release.py --version 2.13.1
  python scripts/publish-release.py --version 2.13.1 --dir packs/3.4.1 --notes-file release-notes.md --draft
  python scripts/publish-release.py --version 3.9.2 --platform linux

产物目录（--dir 缺省）：自动取 packs/<version> 或 packs/<version>-N 中后缀最大者
（打包规范见仓库根 AGENTS.md「工作流」：npm run pack 输出到 packs/<版本号>[-N]）。
"""
import argparse
import base64
import glob
import hashlib
import json
import os
import re
import subprocess
import sys

# Windows 控制台默认 GBK：输出含非 GBK 字符(emoji 等)时 print 会抛 UnicodeEncodeError,
# 表现为「发布其实成功了、脚本却报失败」并吞掉退出码(2026-09-29 实际踩到:收尾那句带了个对勾 emoji)。
# 脚本自身的输出**一律不含 emoji**(规范见仓库根 AGENTS.md「工作流」);这里再把出口兜一道,
# 万一将来混进不可编码字符,退化成打问号而不是让发布脚本崩在最后一行。
try:
    sys.stdout.reconfigure(errors='replace')
    sys.stderr.reconfigure(errors='replace')
except Exception:
    pass

REPO = 'Lousync/Phrontis'


def find_latest_pack_dir(ver):
    """缺省产物目录：packs/<ver> 或 packs/<ver>-N（取后缀数字最大者）；找不到返回 None。"""
    base = 'packs/%s' % ver
    cands = []
    if os.path.isdir(base):
        cands.append(base)
    cands += [d for d in glob.glob('packs/%s-*' % ver) if os.path.isdir(d)]
    if not cands:
        return None

    def suffix(d):
        m = re.match(r'^-(\d+)$', d[len(base):])
        return int(m.group(1)) if m else 0

    return max(cands, key=suffix)


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        sys.stderr.write('GH FAIL: %s\n%s\n' % (' '.join(str(c) for c in cmd), (r.stderr or '')[-2000:]))
        sys.exit(1)
    return r.stdout


def require_gh():
    """gh 缺失时给明确指引，而不是一串 FileNotFoundError 栈。

    这台开发机（以及任何刚拉起来的 Linux 环境）默认没装 gh —— 2026-10-19 实到：
    前面几道门全过，最后一步才崩在 subprocess 上，栈里看不出「只是没装工具」。
    """
    from shutil import which
    if which('gh') is None:
        sys.exit('!! 未找到 gh（GitHub CLI）—— 发布依赖它上传 Release。\n'
                 '   安装：sudo apt install gh（或见 https://github.com/cli/cli#installation），然后 gh auth login')


def local_head_sha():
    """本地 HEAD 的 commit（用来把 tag **钉在打包的这一版代码上**，见 check_counterpart_tag）"""
    r = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ''


def remote_tag_sha(tag):
    """远端同名 tag 指向的 commit（取不到返回 None）。

    用 git ls-remote 而不是 gh api：同一把 SSH/凭据、少一层 JSON、附注 tag 的 `^{}` 行也能一起处理。
    """
    r = subprocess.run(['git', 'ls-remote', '--tags', 'origin', tag], capture_output=True, text=True)
    if r.returncode != 0:
        return None
    peeled = None
    plain = None
    for line in r.stdout.splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        sha, ref = parts
        if ref.endswith('^{}'):
            peeled = sha
        elif ref == 'refs/tags/%s' % tag:
            plain = sha
    return peeled or plain


def check_counterpart_tag(ver, platform, head):
    """已拍板决策 #10：两个平台 tag（v<ver> 与 v<ver>-linux）必须指向**同一个 commit**。

    这里做的是发布前交叉校验：对方 tag 若已存在且指向别的 commit，直接中止 —— 否则会出现
    「Windows 装的是 A 版代码、Linux 装的是 B 版」，而两边版本号一模一样，没人看得出来。
    取不到远端信息（没网 / 未配 origin）时只提示，不阻断（真正上传那步本来也需要网）。
    """
    other = ('v%s' % ver) if platform == 'linux' else ('v%s-linux' % ver)
    got = remote_tag_sha(other)
    if got is None:
        print('  ! 未能读到远端 %s 的 commit（离线 / 未配 origin？）—— 跳过双 tag 一致性校验' % other)
        return
    if not head:
        print('  ! 本机拿不到 HEAD commit，跳过双 tag 一致性校验')
        return
    if got != head:
        sys.exit('!! %s 指向 %s，而本地 HEAD 是 %s\n'
                 '   两平台 tag 必须指向同一个 commit（决策 #10）—— 否则同样版本号、内容不同。\n'
                 '   请确认：① 两边的包都从同一个 commit 打出；② 先合并再发版，或分两次发时把 tag 手动指到同一处。'
                 % (other, got[:12], head[:12]))
    print('  双 tag 一致性 OK：%s 与本地 HEAD 同为 %s' % (other, head[:12]))


def sha512_b64(path):
    h = hashlib.sha512()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return base64.b64encode(h.digest()).decode('ascii')


def parse_latest_yml(path):
    """最小化解析 electron-builder latest.yml / latest-linux.yml(顶层标量 + files 列表),不引 PyYAML 依赖。"""
    text = open(path, 'r', encoding='utf-8').read()
    top = {}
    files = []
    cur = None
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        m = re.match(r'^(\w[\w-]*):\s*(.*)$', line)
        if m and not line.startswith((' ', '-')):
            if m.group(1) == 'files':
                cur = 'files'
            else:
                top[m.group(1)] = m.group(2).strip()
            continue
        if cur == 'files':
            fm = re.match(r'^\s*-\s+url:\s*(.*)$', line)
            if fm:
                files.append({'url': fm.group(1).strip()})
            else:
                km = re.match(r'^\s+(\w[\w-]*):\s*(.*)$', line)
                if km and files:
                    files[-1][km.group(1)] = km.group(2).strip()
    return top, files


# ---------------------------------------------------------------- 平台分叉

def detect_platform(d):
    """按产物目录里实际存在的文件判定平台（老用法不带 --platform 时用）。

    先看扩展名而不是先看更新元数据：`Phrontis-3.9.2-amd64.deb` 与 `Phrontis-3.9.2-setup.exe`
    的扩展名互斥，最不容易误判；两者都在（同一版本号打了两边）则要求显式指定。
    """
    names = [n.lower() for n in os.listdir(d)] if os.path.isdir(d) else []
    has_deb = any(n.endswith('.deb') for n in names)
    has_exe = any(n.endswith('-setup.exe') for n in names)
    if has_deb and has_exe:
        sys.exit('!! 产物目录里同时有 .deb 与 -setup.exe —— 请用 --platform win|linux 明确要发布哪个平台')
    if has_deb:
        return 'linux'
    if has_exe:
        return 'win'
    sys.exit('!! 产物目录里既没有 .deb 也没有 *-setup.exe —— 先跑 npm run pack，或用 --dir 指定目录')


def platform_tag(ver, platform):
    """独立 tag（决策 #6）：Windows = v<ver>，Linux = v<ver>-linux。"""
    return ('v%s-linux' % ver) if platform == 'linux' else ('v%s' % ver)


def collect_win_assets(d, ver):
    """Windows 三件套（原有逻辑原样保留，含 v2.13.0 事故的命名教训）。"""
    names = os.listdir(d)
    # 产物名形如 "Phrontis-<ver>-setup.exe"（由 package.json 的 build.artifactName 决定）。
    # 必须按「-<ver>-setup.exe」精确后缀匹配：`ver in n` 这类子串匹配在
    # 3.0.0 与 3.0.0-beta 共存时会误选旧 beta 包（3.0.0 是 3.0.0-beta 的前缀），
    # 于是 sha512 与 latest.yml 天然对不上，被报成"重新打包使元数据与产物匹配"。
    # v3.2.0 起安装包换名 Phrontis 并显式指定 artifactName（旧名形如
    # "Knowbase Programmer Edition Setup <ver>.exe"，含空格，GitHub 会把 URL 里的空格转成点号）。
    exe_name = next((n for n in names if n.lower().endswith('-%s-setup.exe' % ver.lower())), None)
    if not exe_name:
        sys.exit('!! 未找到 %s 下的 *-%s-setup.exe(产物命名或版本不匹配)' % (d, ver))
    blockmap_name = exe_name + '.blockmap'
    yml_name = 'latest.yml'
    missing = [n for n in (exe_name, blockmap_name, yml_name) if not os.path.isfile(os.path.join(d, n))]
    if missing:
        sys.exit('!! 三件套不完整,缺少: %s\n   禁止发布 —— v2.13.0 事故根因即 exe 先传、元数据后补,导致客户端 integrity check failed' % ', '.join(missing))
    return {
        'pkg_name': exe_name,
        'assets': [os.path.join(d, n) for n in (exe_name, blockmap_name, yml_name)],
        'meta_path': os.path.join(d, yml_name),
        'pkg_path': os.path.join(d, exe_name),
        'meta_name': yml_name,
    }


def collect_linux_assets(d, ver):
    """Linux 两件套：`Phrontis-<ver>-<arch>.deb` + `latest-linux.yml`。

    与 Windows 的差别（都是 electron-builder 的既有行为，不是本项目的取舍）：
      · deb 目标**不产 .blockmap**（那是 NSIS 的增量更新机制），所以没有「三件套」；
      · 更新元数据叫 `latest-linux.yml`（按平台分名，互不覆盖）。
    """
    names = os.listdir(d)
    # artifactName = "Phrontis-${version}-${arch}.${ext}"；deb 的 arch 走 Linux 口径（x64 → amd64）
    deb_name = next((n for n in names if re.match(r'^Phrontis-%s-[a-z0-9]+\.deb$' % re.escape(ver), n, re.I)), None)
    if not deb_name:
        sys.exit('!! 未找到 %s 下的 Phrontis-%s-<arch>.deb(产物命名或版本不匹配)' % (d, ver))
    yml_name = 'latest-linux.yml'
    missing = [n for n in (deb_name, yml_name) if not os.path.isfile(os.path.join(d, n))]
    if missing:
        sys.exit('!! Linux 产物不完整,缺少: %s\n   禁止发布 —— 缺 latest-linux.yml 时客户端无法判断版本，'
                 '缺 deb 时发布页是空壳' % ', '.join(missing))
    return {
        'pkg_name': deb_name,
        'assets': [os.path.join(d, n) for n in (deb_name, yml_name)],
        'meta_path': os.path.join(d, yml_name),
        'pkg_path': os.path.join(d, deb_name),
        'meta_name': yml_name,
    }


def check_deb_control(deb_path, ver):
    """门 0（仅 Linux，尽力而为）：deb 的 control Version 必须与 --version 一致。

    防的是「版本号抬了但忘了重打包」：那时 latest-linux.yml 与 deb 自洽（同一个旧包），
    前三道门全绿，但发出去的包自称旧版本 —— 客户端会一直提示有新版本、装了却还是旧的。
    dpkg-deb 不在（非 Debian 系机器）时跳过，不阻断。
    """
    try:
        r = subprocess.run(['dpkg-deb', '-f', deb_path, 'Version'], capture_output=True, text=True)
    except FileNotFoundError:
        print('  ! 本机没有 dpkg-deb，跳过 control Version 校验')
        return
    if r.returncode != 0:
        print('  ! dpkg-deb 读取失败，跳过 control Version 校验: %s' % (r.stderr or '').strip()[:200])
        return
    got = (r.stdout or '').strip()
    if got != ver:
        sys.exit('!! deb 的 control Version=%r 与 --version=%r 不一致\n   → 版本号抬了但包是旧的，重新 npm run pack' % (got, ver))
    print('  deb control Version 一致: %s' % ver)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--version', required=True, help='要发布的版本号(不带 v 前缀)')
    ap.add_argument('--dir', default=None, help='electron-builder 产物目录（缺省自动取 packs/<version> 或 packs/<version>-N 中后缀最大者）')
    ap.add_argument('--notes-file', default=None, help='Release notes Markdown 文件')
    ap.add_argument('--platform', default='auto', choices=['auto', 'win', 'linux'],
                    help='发布哪个平台（缺省 auto = 按产物目录里的文件判定）。Linux 用独立 tag v<ver>-linux')
    ap.add_argument('--draft', action='store_true', help='创建 draft Release')
    ap.add_argument('--prerelease', action='store_true', help='标记为预发布')
    args = ap.parse_args()

    ver = args.version.lstrip('vV')
    d = args.dir or find_latest_pack_dir(ver)
    if not d:
        sys.exit('!! 未找到产物目录 packs/%s*（先跑 npm run pack，或用 --dir 指定）' % ver)
    if not os.path.isdir(d):
        sys.exit('!! 产物目录不存在: %s（先跑 npm run pack）' % d)

    platform = detect_platform(d) if args.platform == 'auto' else args.platform
    tag = platform_tag(ver, platform)
    print('== 平台 %s → tag %s（产物目录 %s）==' % (platform, tag, d))

    # ---- 门 1:产物齐全 ----
    print('== 门 1:产物存在性 ==')
    if platform == 'linux':
        bundle = collect_linux_assets(d, ver)
        check_deb_control(bundle['pkg_path'], ver)
    else:
        bundle = collect_win_assets(d, ver)
    print('  产物齐全: %s' % ' / '.join(os.path.basename(p) for p in bundle['assets']))

    # ---- 门 2/3:更新元数据与本地安装包实测一致 ----
    print('== 门 2/3:%s 校验 ==' % bundle['meta_name'])
    top, files = parse_latest_yml(bundle['meta_path'])
    yml_ver = top.get('version', '')
    if yml_ver != ver:
        sys.exit('!! %s version=%r 与 --version=%r 不一致' % (bundle['meta_name'], yml_ver, ver))
    print('  version 一致: %s' % ver)
    main_entry = files[0] if files else {}
    yml_sha = main_entry.get('sha512') or top.get('sha512') or ''
    yml_size = int(main_entry.get('size') or 0)
    actual_sha = sha512_b64(bundle['pkg_path'])
    actual_size = os.path.getsize(bundle['pkg_path'])
    if not yml_sha:
        sys.exit('!! %s 未解析出 sha512,拒绝发布(文件内容异常)' % bundle['meta_name'])
    if yml_sha != actual_sha:
        sys.exit('!! sha512 不一致\n   %s : %s\n   本地安装包  : %s\n   → 重新打包使元数据与产物匹配'
                 % (bundle['meta_name'], yml_sha, actual_sha))
    if yml_size and yml_size != actual_size:
        sys.exit('!! size 不一致: %s=%d 实测=%d' % (bundle['meta_name'], yml_size, actual_size))
    yml_blockmap_ref = any(str(f.get('url', '')).endswith('.blockmap') for f in files)
    if platform == 'win' and not yml_blockmap_ref:
        print('  ! latest.yml files 未列出 .blockmap(旧版 electron-builder 常见),仍将随三件套上传')
    print('  sha512/size 与本地安装包实测一致(%d bytes)' % actual_size)

    # ---- 上传:一次 gh 调用带上全部资产(原子性由 gh 单命令上传保证) ----
    print('== 上传 %s ==' % tag)
    require_gh()
    head = local_head_sha()
    check_counterpart_tag(ver, platform, head)
    assets = bundle['assets']
    exists = subprocess.run(['gh', 'release', 'view', tag, '--repo', REPO],
                            capture_output=True, text=True).returncode == 0
    if exists:
        print('  Release 已存在 → 逐资产覆盖上传(--clobber)')
        run(['gh', 'release', 'upload', tag, *assets, '--clobber', '--repo', REPO])
    else:
        cmd = ['gh', 'release', 'create', tag, *assets,
               '--title', tag, '--repo', REPO]
        # ★ tag 必须钉在**本地 HEAD**（= 打包用的那个 commit）上：gh 缺省把新 tag 建在远端默认
        #   分支 HEAD —— 若发版发生在合并之前，tag 就会指到还没包含本版代码的 commit 上，
        #   而两个平台都这么建则「同 commit」这条不变式看着成立、实际两边都错。
        if head:
            cmd += ['--target', head]
        if args.notes_file:
            cmd += ['--notes-file', args.notes_file]
        elif platform == 'linux':
            cmd += ['--notes', 'Phrontis %s（Linux · deb，自 3.9.2 起）。更新内容见 CHANGELOG。' % ver]
        else:
            cmd += ['--notes', 'Phrontis %s。更新内容见 CHANGELOG。' % ver]
        if args.draft:
            cmd += ['--draft']
        if args.prerelease:
            cmd += ['--prerelease']
        run(cmd)

    # ---- 回读验证远端资产齐全(GitHub 会把资产名空格替换为点号,归一化后比对) ----
    print('== 远端验证 ==')
    info = json.loads(run(['gh', 'release', 'view', tag, '--json', 'assets,isDraft', '--repo', REPO]))
    remote = {a['name'].replace(' ', '.'): a['size'] for a in info.get('assets', [])}
    ok = True
    for p in assets:
        n = os.path.basename(p)
        rn = n.replace(' ', '.')
        have = rn in remote
        size_ok = have and remote[rn] == os.path.getsize(p)
        ok = ok and have and size_ok
        print('  %-50s %s' % (rn, 'OK' if (have and size_ok) else ('缺失!' if not have else '大小不符! (%s != %s)' % (remote.get(rn), os.path.getsize(p)))))
    if info.get('isDraft'):
        print('  ! 这是 draft Release,记得发布正式版后客户端才能收到更新')
    if not ok:
        sys.exit(1)
    print('[OK] %s 产物已发布并验证齐全(%s)' % (tag, REPO))


if __name__ == '__main__':
    main()
