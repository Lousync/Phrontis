#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
publish-mascot-pack.py — 书桌伙伴（AI 吉祥物）插件发布到远程市场（Lousync/Phrontis-plugins）

流程：质量门（zip/src 一致性 + mascot 清单合规复刻校验 + 引用 PNG 存在 + icon 安全）
      → 本地生成 zip + 新 registry.json / CHANGELOG.md
      → gh api git data API 链（blob→tree→commit→ref）一次原子提交
      → 验证（registry 可见 + zip sha256 一致）

用法：
  python scripts/publish-mascot-pack.py --version 1.0.0
      [--pack-dir resources/market-plugins/knowbase.mascot-desk-companions]
      [--name "书桌伙伴 · AI 吉祥物"] [--desc "..."] [--changelog "..."]
      [--icon-name knowbase.mascot-desk-companions-icon.svg]
      [--dry-run] [--no-verify]

依赖：gh CLI 已认证（gh api 走代理，curl 直连本机 SSL 失败）。
"""
import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import datetime
import zipfile

REPO = 'Lousync/Phrontis-plugins'
BRANCH = 'main'
MASCOT_STATES = {'idle', 'thinking', 'working', 'sweeping', 'notification', 'error', 'attention'}
ENTRY_RE = re.compile(r'^[\w][\w.-]{0,64}\.html$')
ICON_RE = re.compile(r'^[\w][\w.-]{0,64}\.(svg|png|jpg|jpeg|webp|gif)$', re.I)
PNG_RE = re.compile(r'\.png$', re.I)


def run_gh(args, input_data=None):
    cmd = ['gh', 'api'] + args
    r = subprocess.run(cmd, input=input_data, capture_output=True, text=True, encoding='utf-8')
    if r.returncode != 0:
        sys.stderr.write('GH FAIL: %s\n%s\n' % (' '.join(cmd), r.stderr[-2000:]))
        sys.exit(1)
    return r.stdout


def gh_json(args, input_data=None):
    return json.loads(run_gh(args, input_data))


def b64(path):
    with open(path, 'rb') as f:
        return base64.b64encode(f.read()).decode('ascii')


# ---------- 1. 质量门 ----------

def build_zip(src_dir, zip_path):
    names = []
    for root, _d, files in os.walk(src_dir):
        for fn in sorted(files):
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, src_dir).replace(os.sep, '/')
            names.append((full, rel))
    names.sort(key=lambda x: x[1])
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for full, rel in names:
            z.write(full, rel)
    return names


def check_zip_src_consistency(zip_path, src_dir):
    mismatches = []
    with zipfile.ZipFile(zip_path) as z:
        znames = set(z.namelist())
        for root, _dirs, files in os.walk(src_dir):
            for fn in files:
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, src_dir).replace(os.sep, '/')
                if rel not in znames:
                    mismatches.append('MISSING IN ZIP: %s' % rel)
                    continue
                h1 = hashlib.sha256(open(full, 'rb').read()).hexdigest()
                h2 = hashlib.sha256(z.read(rel)).hexdigest()
                if h1 != h2:
                    mismatches.append('DIFF: %s' % rel)
    return mismatches


def check_manifest_mascot(src_dir):
    """复刻 electron/lib/pluginRegistry.ts 的 mascot 校验（含数组 + 数组内 id 去重）。"""
    m = json.load(open(os.path.join(src_dir, 'plugin.json'), encoding='utf-8'))
    fails = []

    def chk(name, cond):
        if not cond:
            fails.append(name)

    chk('id 格式', re.match(r'^[a-z0-9][a-z0-9._-]*$', m.get('id', '')))
    chk('name 非空且 <=50', isinstance(m.get('name'), str) and 0 < len(m['name']) <= 50)
    chk('version x.y.z', re.match(r'^\d+\.\d+\.\d+', m.get('version', '')))
    chk('type == ui', m.get('type') == 'ui')
    entry = m.get('entry', '')
    chk('entry 为 html', bool(ENTRY_RE.match(entry)))
    chk('entry 文件存在', os.path.exists(os.path.join(src_dir, entry)))
    icon = m.get('icon', '')
    chk('icon 格式', bool(ICON_RE.match(icon)))
    chk('icon 文件存在', os.path.exists(os.path.join(src_dir, icon)))

    mascots = m.get('contributes', {}).get('mascot')
    chk('mascot 为 1-8 数组', isinstance(mascots, list) and 1 <= len(mascots) <= 8)
    ids = set()
    if isinstance(mascots, list):
        for mo in mascots:
            chk('mascot 条目为对象', isinstance(mo, dict))
            if not isinstance(mo, dict):
                continue
            mid = mo.get('id', '')
            chk('mascot.id [%s]' % mid, bool(re.match(r'^[a-z][a-z0-9-]{0,19}$', mid)))
            chk('mascot.id 唯一 [%s]' % mid, mid not in ids)
            ids.add(mid)
            chk('mascot.name <=20 [%s]' % mid, isinstance(mo.get('name'), str) and 0 < len(mo['name']) <= 20)
            fms = mo.get('frameMs', 80)
            chk('mascot.frameMs 20-1000 [%s]' % mid, isinstance(fms, (int, float)) and 20 <= fms <= 1000)
            g = mo.get('grid')
            if g is not None:
                chk('mascot.grid.cell 1-8 [%s]' % mid, isinstance(g, dict) and isinstance(g.get('cell'), (int, float)) and 1 <= g['cell'] <= 8)
                chk('mascot.grid.w/h>0 [%s]' % mid, isinstance(g, dict) and g.get('w', 0) > 0 and g.get('h', 0) > 0)
            sheets = mo.get('sheets')
            chk('mascot.sheets 1-40 [%s]' % mid, isinstance(sheets, dict) and 1 <= len(sheets) <= 40)
            if not isinstance(sheets, dict):
                continue
            for k, s in sheets.items():
                chk('sheet 对象 [%s/%s]' % (mid, k), isinstance(s, dict))
                if not isinstance(s, dict):
                    continue
                b = str(s.get('body', '')).replace('\\', '/')
                chk('sheet.body png 相对路径 [%s/%s]' % (mid, k),
                    bool(b) and not b.startswith('/') and '..' not in b.split('/') and bool(PNG_RE.search(b)))
                chk('sheet.body 文件存在 [%s/%s]' % (mid, k), os.path.exists(os.path.join(src_dir, b)))
                ink = s.get('ink')
                if ink is not None:
                    ni = str(ink).replace('\\', '/')
                    chk('sheet.ink png 相对路径 [%s/%s]' % (mid, k), bool(PNG_RE.search(ni)) and '..' not in ni.split('/'))
                    chk('sheet.ink 文件存在 [%s/%s]' % (mid, k), os.path.exists(os.path.join(src_dir, ni)))
                chk('sheet.frames 正整数 [%s/%s]' % (mid, k), isinstance(s.get('frames'), int) and s['frames'] >= 1)
                box = s.get('box')
                chk('sheet.box 4 非负数 [%s/%s]' % (mid, k), isinstance(box, list) and len(box) == 4 and all(isinstance(n, (int, float)) and n >= 0 for n in box))
                if s.get('still') is not None:
                    chk('sheet.still 范围 [%s/%s]' % (mid, k), isinstance(s.get('still'), int) and 0 <= s['still'] < s.get('frames', 1))
            states = mo.get('states')
            if states is not None:
                chk('mascot.states 对象 [%s]' % mid, isinstance(states, dict))
                if isinstance(states, dict):
                    for sk, av in states.items():
                        chk('state 键合法 [%s/%s]' % (mid, sk), sk in MASCOT_STATES)
                        chk('state 指向已声明 sheet [%s/%s]' % (mid, sk), av in sheets)
            extras = mo.get('idleExtras')
            if extras is not None:
                chk('idleExtras 数组且指向 sheet [%s]' % mid, isinstance(extras, list) and all(e in sheets for e in extras))
    return m, fails


def check_icon_safety(src_dir):
    icon = os.path.join(src_dir, 'icon.svg')
    if not os.path.exists(icon):
        return ['icon.svg 缺失']
    text = open(icon, encoding='utf-8').read()
    return [] if not re.search(r'script|onload|onerror|javascript:', text, re.I) else ['icon.svg 含危险内容']


# ---------- 2. 生成 registry / CHANGELOG ----------

def fetch_remote(path):
    return base64.b64decode(gh_json(['repos/%s/contents/%s' % (REPO, path)])['content']).decode('utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pack-dir', default='resources/market-plugins/knowbase.mascot-desk-companions')
    ap.add_argument('--version', required=True)
    ap.add_argument('--name', default='书桌伙伴 · AI 吉祥物')
    ap.add_argument('--desc', default='三只像素小伙伴（纸灵 / 小墨 / 枭枭）站在 AI 输入卡上沿，随 AI 活动切换动作；到 设置 → AI 助手 → 吉祥物 里选一只。')
    ap.add_argument('--icon-name', default='knowbase.mascot-desk-companions-icon.svg')
    ap.add_argument('--changelog', default='')
    ap.add_argument('--tmp', default=os.environ.get('TEMP', '/tmp'))
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--no-verify', action='store_true')
    args = ap.parse_args()

    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    src = os.path.abspath(os.path.join(repo_root, args.pack_dir))
    tmp = os.path.abspath(args.tmp)
    os.makedirs(tmp, exist_ok=True)

    # ---- 1. 质量门 ----
    print('== 质量门 ==')
    zp = os.path.join(tmp, 'mascot-pack.zip')
    build_zip(src, zp)
    mm = check_zip_src_consistency(zp, src)
    print('zip/src 一致性: %d 差异%s' % (len(mm), '' if not mm else ' -> %s' % mm))
    if mm:
        sys.exit(1)
    m, mf = check_manifest_mascot(src)
    print('mascot 清单校验: %d 问题%s' % (len(mf), '' if not mf else ' -> %s' % mf))
    if mf:
        sys.exit(1)
    ic = check_icon_safety(src)
    print('icon 安全: %d 问题%s' % (len(ic), '' if not ic else ' -> %s' % ic))
    if ic:
        sys.exit(1)
    pid = m['id']
    zip_size = os.path.getsize(zp)
    print('[OK] 质量门通过：%s v%s（zip %d bytes，%d 只吉祥物）' % (pid, args.version, zip_size, len(m['contributes']['mascot'])))

    if args.dry_run:
        print('[DRY-RUN] 跳过远程提交。zip=%s' % zp)
        return

    # ---- 2. 拉取远程现状 ----
    print('== 准备发布 ==')
    reg = json.loads(fetch_remote('registry.json'))
    old_v = reg.get('registryVersion', 0)
    new_v = old_v + 1
    changelog = fetch_remote('CHANGELOG.md')
    if any(p['id'] == pid for p in reg['plugins']):
        print('!! 远程已存在 %s，请先处理重复条目（更新场景需另行编写更新逻辑）' % pid)
        sys.exit(1)

    today = datetime.date.today().isoformat()
    entry = {
        'id': pid,
        'name': args.name,
        'version': args.version,
        'description': args.desc,
        'author': 'Knowbase',
        'downloadUrl': 'https://raw.githubusercontent.com/%s/main/plugins/%s-%s.zip' % (REPO, pid, args.version),
        'iconUrl': 'https://raw.githubusercontent.com/%s/main/plugins/%s' % (REPO, args.icon_name),
        'category': '外观',
        'riskLevel': 'B',
        'contributions': ['mascot'],
        'size': zip_size,
        'updatedAt': today,
    }
    reg['registryVersion'] = new_v
    reg['plugins'].append(entry)

    marker = '## %s\n' % today
    item = '- **新增插件 · 书桌伙伴 · AI 吉祥物 v%s**：%s（registry v%d）\n' % (
        args.version, (args.changelog or '三只像素吉祥物，随 AI 活动切换动作'), new_v)
    if marker in changelog:
        changelog = changelog.replace(marker, marker + '\n' + item, 1)
    else:
        first_nl = changelog.find('\n')
        changelog = changelog[:first_nl + 1] + '\n' + marker + '\n' + item + changelog[first_nl + 1:]

    reg_f = os.path.join(tmp, 'mascot-new-registry.json')
    cl_f = os.path.join(tmp, 'mascot-new-changelog.md')
    open(reg_f, 'w', encoding='utf-8', newline='\n').write(json.dumps(reg, ensure_ascii=False, indent=2) + '\n')
    open(cl_f, 'w', encoding='utf-8', newline='\n').write(changelog)
    print('registry v%d -> v%d（%d 条目），条目与 CHANGELOG 已生成' % (old_v, new_v, len(reg['plugins'])))

    # ---- 3. git data API 链 ----
    print('== 发布（git data API 链）==')
    ref = gh_json(['repos/%s/git/ref/heads/%s' % (REPO, BRANCH)])
    main_sha = ref['object']['sha']
    base_tree = gh_json(['repos/%s/git/commits/%s' % (REPO, main_sha)])['tree']['sha']
    files = {
        'plugins/%s-%s.zip' % (pid, args.version): zp,
        'plugins/%s' % args.icon_name: os.path.join(src, 'icon.svg'),
        'registry.json': reg_f,
        'CHANGELOG.md': cl_f,
    }
    blobs = {}
    for path, local in files.items():
        body = json.dumps({'content': b64(local), 'encoding': 'base64'})
        blobs[path] = gh_json(['repos/%s/git/blobs' % REPO, '-X', 'POST', '--input', '-'], input_data=body)['sha']
        print('  blob %s: %s' % (path, blobs[path][:12]))
    tree_items = [{'path': p, 'mode': '100644', 'type': 'blob', 'sha': s} for p, s in blobs.items()]
    new_tree = gh_json(['repos/%s/git/trees' % REPO, '-X', 'POST', '--input', '-'],
                       input_data=json.dumps({'base_tree': base_tree, 'tree': tree_items}))['sha']
    msg = 'feat(registry): %s v%s（registry v%d）' % (pid, args.version, new_v)
    new_commit = gh_json(['repos/%s/git/commits' % REPO, '-X', 'POST', '--input', '-'],
                         input_data=json.dumps({'message': msg, 'tree': new_tree, 'parents': [main_sha]}, ensure_ascii=False))['sha']
    gh_json(['repos/%s/git/refs/heads/%s' % (REPO, BRANCH), '-X', 'PATCH', '--input', '-'],
            input_data=json.dumps({'sha': new_commit, 'force': False}))
    print('  提交 %s，ref 已更新' % new_commit[:12])

    # ---- 4. 验证 ----
    if not args.no_verify:
        print('== 验证 ==')
        reg2 = json.loads(fetch_remote('registry.json'))
        ok1 = reg2.get('registryVersion') == new_v and any(p['id'] == pid and p['version'] == args.version for p in reg2['plugins'])
        print('  registry v%s, %s %s: %s' % (reg2.get('registryVersion'), pid, args.version, 'OK' if ok1 else 'FAIL'))
        down = os.path.join(tmp, 'mascot-verify.zip')
        api = 'repos/%s/contents/plugins/%s-%s.zip' % (REPO, pid, args.version)
        with open(down, 'wb') as f:
            f.write(base64.b64decode(gh_json([api])['content']))
        ok2 = hashlib.sha256(open(down, 'rb').read()).hexdigest() == hashlib.sha256(open(zp, 'rb').read()).hexdigest() and zipfile.ZipFile(down).testzip() is None
        print('  zip sha256 一致 + 完整性: %s' % ('OK' if ok2 else 'FAIL'))
        if not (ok1 and ok2):
            sys.exit(1)
        print('[OK] 验证通过')

    print('发布完成：%s v%s（registry v%d）commit %s' % (pid, args.version, new_v, new_commit[:12]))


if __name__ == '__main__':
    main()
