#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
发布错题本插件到插件市场（Lousync/Phrontis-plugins）。
流程：质量门(manifest/zip 一致性/防重复) → 生成 registry.json + CHANGELOG → git data API 链原子提交 → 验证 sha256。
用法：python scripts/publish-quizbook.py --zip samples/quizbook-0.2.0.zip --version 0.2.0 --name "错题本（插件版）" --desc "..." [--changelog "..."]
"""
import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import zipfile

REPO = 'Lousync/Phrontis-plugins'
BRANCH = 'main'
PLUGIN_ID = 'knowbase.quizbook'
TODAY = '2026-08-30'


def run_gh(args, input_data=None):
    cmd = ['gh', 'api', *args]
    if input_data is not None:
        cmd += ['--input', '-']
    r = subprocess.run(cmd, input=input_data, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(f'GH FAIL: {" ".join(cmd)}\n{r.stderr[-2000:]}\n')
        sys.exit(1)
    return r.stdout


def gh_json(args, input_data=None):
    return json.loads(run_gh(args, input_data))


def fetch_remote(path):
    return run_gh(['repos/%s/contents/%s' % (REPO, path), '-H', 'Accept: application/vnd.github.raw'])


def b64(path):
    with open(path, 'rb') as f:
        return base64.b64encode(f.read()).decode('ascii')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--zip', required=True)
    ap.add_argument('--version', required=True)
    ap.add_argument('--name', default='错题本（插件版）')
    ap.add_argument('--desc', default='错题本彻底插件化：数据存插件自有表（plugin_knowbase_quizbook_*），书架按科目分、书内按章节归档，重刷复用宿主刷题器。需应用支持 C 级模块插件。')
    ap.add_argument('--changelog', default='上架错题本插件版 v0.2.0（C 级模块插件：自有数据表 + 宿主刷题器复用）')
    ap.add_argument('--no-verify', action='store_true')
    args = ap.parse_args()

    zp = os.path.abspath(args.zip)
    ver = args.version
    if not os.path.exists(zp):
        sys.exit(f'zip 不存在: {zp}')

    # ---- 1. 质量门 ----
    print('== 质量门 ==')
    with zipfile.ZipFile(zp) as z:
        names = z.namelist()
        assert 'plugin.json' in names, 'zip 根目录缺少 plugin.json'
        manifest = json.loads(z.read('plugin.json'))
        assert z.testzip() is None, 'zip 完整性校验失败'
    assert manifest.get('id') == PLUGIN_ID, f'manifest id 应为 {PLUGIN_ID}, 实际 {manifest.get("id")}'
    assert manifest.get('version') == ver, f'manifest version 应为 {ver}, 实际 {manifest.get("version")}'
    assert manifest.get('riskLevel') == 'C', '错题本插件必须是 C 级'
    zip_size = os.path.getsize(zp)
    print(f'  manifest OK: {PLUGIN_ID}@{ver}, C 级, {zip_size} bytes')

    reg = json.loads(fetch_remote('registry.json'))
    existing = next((p for p in reg['plugins'] if p['id'] == PLUGIN_ID), None)
    if existing:
        if existing.get('version') == ver:
            sys.exit(f'!! 远程已存在 {PLUGIN_ID} v{ver}（版本相同，防重复发布）。升版本或用 --force-update 覆盖')
        print(f'  检测到旧版本 v{existing.get("version")} → 更新到 v{ver}')
    old_v = reg.get('registryVersion', 0)
    new_v = old_v + 1
    changelog = fetch_remote('CHANGELOG.md')

    icon_name = None
    if manifest.get('icon'):
        icon_name = f'{PLUGIN_ID}-icon.svg'

    entry = {
        'id': PLUGIN_ID,
        'name': args.name,
        'version': ver,
        'description': args.desc,
        'author': 'Knowbase',
        'downloadUrl': f'https://raw.githubusercontent.com/{REPO}/main/plugins/{PLUGIN_ID}-{ver}.zip',
        'category': '学习',
        'riskLevel': 'C',
        'capabilities': ['data', 'knowledge'],
        'contributions': ['tables', 'views'],
        'size': zip_size,
        'updatedAt': TODAY,
    }
    if icon_name:
        entry['iconUrl'] = f'https://raw.githubusercontent.com/{REPO}/main/plugins/{icon_name}'
    reg['registryVersion'] = new_v
    if existing:
        reg['plugins'] = [entry if p['id'] == PLUGIN_ID else p for p in reg['plugins']]
    else:
        reg['plugins'].append(entry)

    marker = f'## {TODAY}\n'
    if marker in changelog:
        changelog = changelog.replace(marker, marker + f'- **{args.changelog}**（registry v{new_v}）\n', 1)
    else:
        changelog = changelog.rstrip() + f'\n\n{marker}- **{args.changelog}**（registry v{new_v}）\n'

    tmp = tempfile.mkdtemp(prefix='quizbook-pub-')
    reg_f = os.path.join(tmp, 'registry.json')
    cl_f = os.path.join(tmp, 'CHANGELOG.md')
    open(reg_f, 'w', encoding='utf-8', newline='\n').write(json.dumps(reg, ensure_ascii=False, indent=2) + '\n')
    open(cl_f, 'w', encoding='utf-8', newline='\n').write(changelog)
    print(f'registry v{old_v} -> v{new_v}（{len(reg["plugins"])} 条目）')

    # ---- 2. git data API 链 ----
    print('== 发布（git data API 链）==')
    main_sha = gh_json([f'repos/{REPO}/git/ref/heads/{BRANCH}'])['object']['sha']
    base_tree = gh_json([f'repos/{REPO}/git/commits/{main_sha}'])['tree']['sha']
    files = {
        f'plugins/{PLUGIN_ID}-{ver}.zip': zp,
        'registry.json': reg_f,
        'CHANGELOG.md': cl_f,
    }
    if icon_name:
        # 图标源：同目录 icon.svg 或手动指定
        icon_local = os.path.join(os.path.dirname(zp), 'icon.svg')
        if not os.path.exists(icon_local):
            icon_local = os.path.join('samples', 'quizbook', 'icon.svg')
        if os.path.exists(icon_local):
            files[f'plugins/{icon_name}'] = icon_local
            print(f'  + 图标 {icon_name}')
        else:
            print(f'  ! 未找到图标文件，跳过 iconUrl 上传（{icon_local}）')
    blobs = {}
    for path, local in files.items():
        body = json.dumps({'content': b64(local), 'encoding': 'base64'})
        blobs[path] = gh_json([f'repos/{REPO}/git/blobs', '-X', 'POST', '--input', '-'], input_data=body)['sha']
        print(f'  blob {path}: {blobs[path][:12]}')
    tree_items = [{'path': p, 'mode': '100644', 'type': 'blob', 'sha': s} for p, s in blobs.items()]
    new_tree = gh_json([f'repos/{REPO}/git/trees', '-X', 'POST', '--input', '-'],
                       input_data=json.dumps({'base_tree': base_tree, 'tree': tree_items}))['sha']
    msg = f'feat(registry): {PLUGIN_ID} v{ver}（registry v{new_v}）'
    new_commit = gh_json([f'repos/{REPO}/git/commits', '-X', 'POST', '--input', '-'],
                         input_data=json.dumps({'message': msg, 'tree': new_tree, 'parents': [main_sha]}, ensure_ascii=False))['sha']
    gh_json([f'repos/{REPO}/git/refs/heads/{BRANCH}', '-X', 'PATCH', '--input', '-'],
            input_data=json.dumps({'sha': new_commit, 'force': False}))
    print(f'  提交 {new_commit[:12]}，ref 已更新')

    # ---- 3. 验证 ----
    if not args.no_verify:
        print('== 验证 ==')
        reg2 = json.loads(fetch_remote('registry.json'))
        ok1 = reg2.get('registryVersion') == new_v and any(p['id'] == PLUGIN_ID and p['version'] == ver for p in reg2['plugins'])
        print(f'  registry v{reg2.get("registryVersion")}, {PLUGIN_ID} {ver}: {"OK" if ok1 else "FAIL"}')
        down = os.path.join(tmp, 'verify.zip')
        gh_api = f'repos/{REPO}/contents/plugins/{PLUGIN_ID}-{ver}.zip'
        with open(down, 'wb') as f:
            f.write(base64.b64decode(gh_json([gh_api])['content']))
        h1 = hashlib.sha256(open(down, 'rb').read()).hexdigest()
        h2 = hashlib.sha256(open(zp, 'rb').read()).hexdigest()
        ok2 = h1 == h2 and zipfile.ZipFile(down).testzip() is None
        print(f'  zip sha256 一致 + 完整性: {"OK" if ok2 else "FAIL"}')
        if not (ok1 and ok2):
            sys.exit(1)
    print(f'[OK] {PLUGIN_ID} v{ver} 已上架（registry v{new_v}）')


if __name__ == '__main__':
    main()
