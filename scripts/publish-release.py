#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
应用安装包发布脚本（三件套完整性门）—— v2.13.0「先传 exe、后补 latest.yml/blockmap」事故的发布侧防线。

门 1：安装包 .exe（`Phrontis-<ver>-setup.exe`）、同名 .exe.blockmap、latest.yml 三件套必须同时存在于产物目录
门 2：latest.yml 的 sha512(base64)/size 与本地 exe 实测一致
门 3：latest.yml 顶层 version 与 --version 一致
通过后 gh release 一次性原子上传三件套，并回读远端资产列表校验齐全。

用法：
  python scripts/publish-release.py --version 2.13.1
  python scripts/publish-release.py --version 2.13.1 --dir dist-electron --notes-file release-notes.md --draft
"""
import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys

REPO = 'Lousync/Phrontis'


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        sys.stderr.write('GH FAIL: %s\n%s\n' % (' '.join(str(c) for c in cmd), (r.stderr or '')[-2000:]))
        sys.exit(1)
    return r.stdout


def sha512_b64(path):
    h = hashlib.sha512()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return base64.b64encode(h.digest()).decode('ascii')


def parse_latest_yml(path):
    """最小化解析 electron-builder latest.yml(顶层标量 + files 列表),不引 PyYAML 依赖。"""
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--version', required=True, help='要发布的版本号(不带 v 前缀)')
    ap.add_argument('--dir', default='dist-electron', help='electron-builder 产物目录')
    ap.add_argument('--notes-file', default=None, help='Release notes Markdown 文件')
    ap.add_argument('--draft', action='store_true', help='创建 draft Release')
    ap.add_argument('--prerelease', action='store_true', help='标记为预发布')
    args = ap.parse_args()

    ver = args.version.lstrip('vV')
    tag = 'v%s' % ver
    d = args.dir
    if not os.path.isdir(d):
        sys.exit('!! 产物目录不存在: %s(先跑 electron-builder 打包)' % d)

    # ---- 门 1:三件套必须同时存在 ----
    print('== 门 1:三件套存在性 ==')
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
    exe_p, blockmap_p, yml_p = (os.path.join(d, n) for n in (exe_name, blockmap_name, yml_name))
    print('  三件套齐全: %s / %s / %s' % (exe_name, blockmap_name, yml_name))

    # ---- 门 2/3:latest.yml 与本地 exe 实测一致 ----
    print('== 门 2/3:latest.yml 校验 ==')
    top, files = parse_latest_yml(yml_p)
    yml_ver = top.get('version', '')
    if yml_ver != ver:
        sys.exit('!! latest.yml version=%r 与 --version=%r 不一致' % (yml_ver, ver))
    print('  version 一致: %s' % ver)
    main_entry = files[0] if files else {}
    yml_sha = main_entry.get('sha512') or top.get('sha512') or ''
    yml_size = int(main_entry.get('size') or 0)
    actual_sha = sha512_b64(exe_p)
    actual_size = os.path.getsize(exe_p)
    if not yml_sha:
        sys.exit('!! latest.yml 未解析出 sha512,拒绝发布(文件内容异常)')
    if yml_sha != actual_sha:
        sys.exit('!! sha512 不一致\n   latest.yml : %s\n   本地 exe  : %s\n   → 重新打包使元数据与产物匹配' % (yml_sha, actual_sha))
    if yml_size and yml_size != actual_size:
        sys.exit('!! size 不一致: latest.yml=%d 实测=%d' % (yml_size, actual_size))
    yml_blockmap_ref = any(str(f.get('url', '')).endswith('.blockmap') for f in files)
    if not yml_blockmap_ref:
        print('  ! latest.yml files 未列出 .blockmap(旧版 electron-builder 常见),仍将随三件套上传')
    print('  sha512/size 与本地 exe 实测一致(%d bytes)' % actual_size)

    # ---- 上传:一次 gh 调用带上全部三件套(原子性由 gh 单命令上传保证) ----
    print('== 上传 %s ==' % tag)
    assets = [exe_p, blockmap_p, yml_p]
    exists = subprocess.run(['gh', 'release', 'view', tag, '--repo', REPO],
                            capture_output=True, text=True).returncode == 0
    if exists:
        print('  Release 已存在 → 逐资产覆盖上传(--clobber)')
        run(['gh', 'release', 'upload', tag, *assets, '--clobber', '--repo', REPO])
    else:
        cmd = ['gh', 'release', 'create', tag, *assets,
               '--title', tag, '--repo', REPO]
        if args.notes_file:
            cmd += ['--notes-file', args.notes_file]
        else:
            cmd += ['--notes', 'Knowbase %s。更新内容见 CHANGELOG。' % ver]
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
    for n, p in ((exe_name, exe_p), (blockmap_name, blockmap_p), (yml_name, yml_p)):
        rn = n.replace(' ', '.')
        have = rn in remote
        size_ok = have and remote[rn] == os.path.getsize(p)
        ok = ok and have and size_ok
        print('  %-50s %s' % (rn, 'OK' if (have and size_ok) else ('缺失!' if not have else '大小不符! (%s != %s)' % (remote.get(rn), os.path.getsize(p)))))
    if info.get('isDraft'):
        print('  ! 这是 draft Release,记得发布正式版后客户端才能收到更新')
    if not ok:
        sys.exit(1)
    print('✅ %s 三件套已发布并验证齐全(%s)' % (tag, REPO))


if __name__ == '__main__':
    main()
