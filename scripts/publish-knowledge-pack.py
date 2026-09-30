#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
publish-knowledge-pack.py — 知识包发布到远程市场（Lousync/Phrontis-plugins）

流程：质量门（zip/src 一致性 + quiz JSON 合法性 + manifest 合规复刻校验 + icon 安全）
      → 本地生成新 registry.json / CHANGELOG.md
      → gh api git data API 链（blob→tree→commit→ref）一次原子提交
      → 验证（registry 可见 + zip sha256 一致）

用法（示例）：
  python scripts/publish-knowledge-pack.py \
    --pack-dir plugins/knowbase.kb-politics-pack \
    --zip plugins/knowbase.kb-politics-pack.zip \
    --version 1.0.0 \
    --name "考研政治学习空间" \
    --desc "考研政治知识包：..." \
    --icon-name kb-politics-pack-icon.svg \
    --changelog "新增插件 · 考研政治学习空间 v1.0.0：..."
    [--no-verify]

依赖：gh CLI 已认证（gh api 走代理，curl 直连 GitHub 在本环境 SSL 失败）
参考：docs/knowledge-pack-answer-format.md §配套工具；.workbuddy/memory/MEMORY.md
"""
import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import zipfile

REPO = 'Lousync/Phrontis-plugins'
BRANCH = 'main'

# ---------- 工具 ----------

def run_gh(args, input_data=None):
    cmd = ['gh', 'api'] + args
    r = subprocess.run(cmd, input=input_data, capture_output=True, text=True, encoding='utf-8')
    if r.returncode != 0:
        sys.stderr.write(f'GH FAIL: {" ".join(cmd)}\n{r.stderr[-2000:]}\n')
        sys.exit(1)
    return r.stdout

def gh_json(args, input_data=None):
    return json.loads(run_gh(args, input_data))

def b64(path):
    with open(path, 'rb') as f:
        return base64.b64encode(f.read()).decode('ascii')

# ---------- 1. 质量门 ----------

def check_zip_src_consistency(zip_path, src_dir):
    """zip 内每个文件与源码目录 sha256 逐一比对"""
    mismatches = []
    with zipfile.ZipFile(zip_path) as z:
        znames = set(z.namelist())
        for root, _dirs, files in os.walk(src_dir):
            for fn in files:
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, src_dir).replace(os.sep, '/')
                h1 = hashlib.sha256(open(full, 'rb').read()).hexdigest()
                if rel not in znames:
                    mismatches.append(f'MISSING IN ZIP: {rel}')
                    continue
                h2 = hashlib.sha256(z.read(rel)).hexdigest()
                if h1 != h2:
                    mismatches.append(f'DIFF: {rel}')
        for n in znames:
            if n not in {os.path.relpath(os.path.join(r, f), src_dir).replace(os.sep, '/')
                         for r, _d, fs in os.walk(src_dir) for f in fs}:
                mismatches.append(f'EXTRA IN ZIP: {n}')
    return mismatches


def check_quiz_json(src_dir):
    """扫描所有 .md 中的 ```quiz 围栏，校验 JSON 可解析 + 必填字段 + answer 在选项内"""
    issues = []
    total = 0
    quiz_re = re.compile(r'```quiz\n(.*?)\n```', re.DOTALL)
    for root, _d, files in os.walk(src_dir):
        for fn in files:
            if not fn.endswith('.md'):
                continue
            text = open(os.path.join(root, fn), encoding='utf-8').read()
            for i, block in enumerate(re.findall(quiz_re, text), 1):
                total += 1
                try:
                    q = json.loads(block)
                except Exception as e:
                    issues.append(f'{os.path.relpath(os.path.join(root, fn), src_dir)} quiz#{i}: JSON 解析失败 {e}')
                    continue
                for k in ('no', 'points', 'question', 'options', 'answer', 'explanation'):
                    if k not in q:
                        issues.append(f'{os.path.relpath(os.path.join(root, fn), src_dir)} quiz#{i}: 缺字段 {k}')
                opts = q.get('options', [])
                keys = ''.join(o.get('key', '') for o in opts if isinstance(o, dict))
                ans = q.get('answer', '')
                if ans and not all(c in keys for c in ans):
                    issues.append(f'{os.path.relpath(os.path.join(root, fn), src_dir)} quiz#{i}: answer {ans!r} 不在选项 {keys!r}')
    return total, issues


def check_manifest(src_dir, plugin_json='plugin.json'):
    """复刻 electron/lib/pluginRegistry.ts 校验逻辑（knowledgePages v2）"""
    m = json.load(open(os.path.join(src_dir, plugin_json), encoding='utf-8'))
    fails = []
    def chk(name, cond):
        if not cond:
            fails.append(name)

    chk('id 格式', re.match(r'^[a-z0-9][a-z0-9._-]*$', m.get('id', '')))
    chk('icon 格式', re.match(r'^[\w][\w.-]{0,64}\.(svg|png|jpg|jpeg|webp|gif)$', m.get('icon', '')))
    kp = m.get('contributes', {}).get('knowledgePages', {})
    chk('space ≤60', len(kp.get('space', '')) <= 60)
    nbs = kp.get('notebooks', [])
    chk('notebooks 1-20', 1 <= len(nbs) <= 20)
    total = 0
    for b in nbs:
        chk(f"notebook 名≤50 [{b.get('name', '')}]", len(b.get('name', '')) <= 50)
        chk(f"coverColor [{b.get('name', '')}]", re.match(r'^#[0-9a-fA-F]{6}$', b.get('coverColor', '')))
        for c in b.get('chapters', []):
            chk(f"chapter 名≤50 [{c.get('name', '')}]", len(c.get('name', '')) <= 50)
            for p in c.get('pages', []):
                total += 1
                fp = p.get('file', '')
                chk(f'file 路径 {fp}', re.match(r'^[\w][\w\-./ ]{0,150}\.md$', fp) and '..' not in fp)
                chk(f'externalId {p.get("externalId", "")}',
                    bool(re.match(r'^[A-Za-z0-9._-]{1,64}$', p.get('externalId', ''))))
                full = os.path.join(src_dir, fp)
                if os.path.exists(full) and os.path.getsize(full) > 512 * 1024:
                    chk(f'单页超 512KB {fp}', False)
    chk('总页数 ≤1500', total <= 1500)
    return m, total, fails


def check_icon_safety(src_dir):
    """icon.svg 禁 script/on*/javascript:"""
    icon = os.path.join(src_dir, 'icon.svg')
    if not os.path.exists(icon):
        return ['icon.svg 缺失']
    text = open(icon, encoding='utf-8').read()
    return [] if not re.search(r'script|onload|onerror|javascript:', text, re.I) else ['icon.svg 含危险内容']


# ---------- 2. 生成 registry / CHANGELOG ----------

def fetch_remote(path):
    return base64.b64decode(gh_json([f'repos/{REPO}/contents/{path}'])['content']).decode('utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pack-dir', required=True, help='插件源码目录（含 plugin.json）')
    ap.add_argument('--zip', required=True, help='打包好的 zip 路径')
    ap.add_argument('--version', required=True)
    ap.add_argument('--name', required=True, help='市场显示名（registry.name）')
    ap.add_argument('--desc', required=True, help='registry.description（市场卡片描述）')
    ap.add_argument('--icon-name', required=True, help='远程 icon 文件名，如 kb-politics-pack-icon.svg')
    ap.add_argument('--changelog', required=True, help='CHANGELOG 条目文本（含版本与 registry vN）')
    ap.add_argument('--tmp', default=os.environ.get('TEMP', '/tmp'), help='临时目录')
    ap.add_argument('--no-verify', action='store_true', help='跳过发布后验证')
    args = ap.parse_args()

    src = os.path.abspath(args.pack_dir)
    zp = os.path.abspath(args.zip)
    pid = json.load(open(os.path.join(src, 'plugin.json'), encoding='utf-8'))['id']
    zip_size = os.path.getsize(zp)

    # ---- 1. 质量门 ----
    print('== 质量门 ==')
    mm = check_zip_src_consistency(zp, src)
    print(f'zip/src 一致性: {len(mm)} 差异' + ('' if not mm else f' -> {mm}'))
    if mm:
        sys.exit(1)
    total_q, quiz_issues = check_quiz_json(src)
    print(f'quiz 校验: {total_q} 题, {len(quiz_issues)} 问题' + ('' if not quiz_issues else f' -> {quiz_issues}'))
    if quiz_issues:
        sys.exit(1)
    m, total_p, mf_fails = check_manifest(src)
    print(f'manifest 校验: {total_p} 页, {len(mf_fails)} 问题' + ('' if not mf_fails else f' -> {mf_fails}'))
    if mf_fails:
        sys.exit(1)
    icon_issues = check_icon_safety(src)
    print(f'icon 安全: {len(icon_issues)} 问题' + ('' if not icon_issues else f' -> {icon_issues}'))
    if icon_issues:
        sys.exit(1)
    print('[OK] 质量门通过')

    # ---- 2. 拉取远程现状 ----
    print('== 准备发布 ==')
    reg = json.loads(fetch_remote('registry.json'))
    old_v = reg.get('registryVersion', 0)
    new_v = old_v + 1
    changelog = fetch_remote('CHANGELOG.md')
    if any(p['id'] == pid for p in reg['plugins']):
        print(f'!! 远程已存在 {pid}（v{next(p["version"] for p in reg["plugins"] if p["id"] == pid)}），请先处理重复条目')
        sys.exit(1)

    entry = {
        'id': pid,
        'name': args.name,
        'version': args.version,
        'description': args.desc,
        'author': 'Knowbase',
        'downloadUrl': f'https://raw.githubusercontent.com/{REPO}/main/plugins/{pid}-{args.version}.zip',
        'iconUrl': f'https://raw.githubusercontent.com/{REPO}/main/plugins/{args.icon_name}',
        'category': '知识包',
        'riskLevel': 'A',
        'contributions': ['knowledgePages'],
        'size': zip_size,
        'updatedAt': '2026-08-29',
    }
    reg['registryVersion'] = new_v
    reg['plugins'].append(entry)

    marker = '## 2026-08-29\n'
    if marker in changelog:
        changelog = changelog.replace(marker, marker + f'- **{args.changelog}**（registry v{new_v}）\n', 1)
    else:
        changelog = changelog.rstrip() + f'\n\n{marker}- **{args.changelog}**（registry v{new_v}）\n'

    tmp = os.path.abspath(args.tmp)
    os.makedirs(tmp, exist_ok=True)
    reg_f = os.path.join(tmp, 'kb-new-registry.json')
    cl_f = os.path.join(tmp, 'kb-new-changelog.md')
    open(reg_f, 'w', encoding='utf-8', newline='\n').write(json.dumps(reg, ensure_ascii=False, indent=2) + '\n')
    open(cl_f, 'w', encoding='utf-8', newline='\n').write(changelog)
    print(f'registry v{old_v} -> v{new_v}（{len(reg["plugins"])} 条目），条目与 CHANGELOG 已生成')

    # ---- 3. git data API 链 ----
    print('== 发布（git data API 链）==')
    ref = gh_json([f'repos/{REPO}/git/ref/heads/{BRANCH}'])
    main_sha = ref['object']['sha']
    base_tree = gh_json([f'repos/{REPO}/git/commits/{main_sha}'])['tree']['sha']
    files = {
        f'plugins/{pid}-{args.version}.zip': zp,
        f'plugins/{args.icon_name}': os.path.join(src, 'icon.svg'),
        'registry.json': reg_f,
        'CHANGELOG.md': cl_f,
    }
    blobs = {}
    for path, local in files.items():
        body = json.dumps({'content': b64(local), 'encoding': 'base64'})
        blobs[path] = gh_json([f'repos/{REPO}/git/blobs', '-X', 'POST', '--input', '-'], input_data=body)['sha']
        print(f'  blob {path}: {blobs[path][:12]}')
    tree_items = [{'path': p, 'mode': '100644', 'type': 'blob', 'sha': s} for p, s in blobs.items()]
    new_tree = gh_json([f'repos/{REPO}/git/trees', '-X', 'POST', '--input', '-'],
                       input_data=json.dumps({'base_tree': base_tree, 'tree': tree_items}))['sha']
    msg = f'feat(registry): {pid} v{args.version}（registry v{new_v}）'
    new_commit = gh_json([f'repos/{REPO}/git/commits', '-X', 'POST', '--input', '-'],
                         input_data=json.dumps({'message': msg, 'tree': new_tree, 'parents': [main_sha]}, ensure_ascii=False))['sha']
    gh_json([f'repos/{REPO}/git/refs/heads/{BRANCH}', '-X', 'PATCH', '--input', '-'],
            input_data=json.dumps({'sha': new_commit, 'force': False}))
    print(f'  提交 {new_commit[:12]}，ref 已更新')

    # ---- 4. 验证 ----
    if not args.no_verify:
        print('== 验证 ==')
        reg2 = json.loads(fetch_remote('registry.json'))
        ok1 = reg2.get('registryVersion') == new_v and any(p['id'] == pid and p['version'] == args.version for p in reg2['plugins'])
        print(f'  registry v{reg2.get("registryVersion")}, {pid} {args.version}: {"OK" if ok1 else "FAIL"}')
        down = os.path.join(tmp, 'kb-verify.zip')
        gh_api = f'repos/{REPO}/contents/plugins/{pid}-{args.version}.zip'
        with open(down, 'wb') as f:
            f.write(base64.b64decode(gh_json([gh_api])['content']))
        h1 = hashlib.sha256(open(down, 'rb').read()).hexdigest()
        h2 = hashlib.sha256(open(zp, 'rb').read()).hexdigest()
        ok2 = h1 == h2 and zipfile.ZipFile(down).testzip() is None
        print(f'  zip sha256 一致 + 完整性: {"OK" if ok2 else "FAIL"}')
        if not (ok1 and ok2):
            sys.exit(1)
        print('[OK] 验证通过')

    print(f'发布完成：{pid} v{args.version}（registry v{new_v}）commit {new_commit[:12]}')


if __name__ == '__main__':
    main()
