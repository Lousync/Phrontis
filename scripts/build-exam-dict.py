#!/usr/bin/env python3
"""
从 ECDICT 全量词库构建考纲精简词典 resources/dict/ecdict-exam.json。

筛选规则：tag 含 cet4 / cet6 / ky（考研）的词条，并辅以高频词兜底
（BNC 词频或当代语料库词频前 20000），保证选读文章里的常见词都能命中；
考纲标签单独保留在词条 tag 字段里供 UI 做徽章。数据源（按顺序尝试）：
本地缓存 %TEMP%/ecdict/ → gh-proxy 镜像 → GitHub raw。

用法：
    python scripts/build-exam-dict.py
可选参数：
    --csv    全量 ecdict.csv 路径（默认用缓存/下载）
    --lemma  lemma.en.txt 路径
    --out    输出路径（默认 resources/dict/ecdict-exam.json）
    --lemma-only  只重算 lemma 反查表（复用 --out 里现有的 words/roots 等，
                  不下载 100MB CSV）。修词形表规则后用它就地重刷即可。
词根数据：ECDICT 的 wordroot.txt（JSON 格式，root→释义/词源/例词），
经倒排后输出两个索引：
    roots     root → {m:词根含义, c:类别, o:词源, words:词典内例词}
    wordRoots word → [root,...]（同根词反查）
"""

import argparse
import csv
import json
import os
import sys
import tempfile
import urllib.request

CSV_URLS = [
    "https://gh-proxy.com/https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv",
    "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv",
]
LEMMA_URLS = [
    "https://gh-proxy.com/https://raw.githubusercontent.com/skywind3000/ECDICT/master/lemma.en.txt",
    "https://raw.githubusercontent.com/skywind3000/ECDICT/master/lemma.en.txt",
]
EXAM_TAGS = {"cet4", "cet6", "ky"}
FREQ_LIMIT = 20000  # 高频词兜底阈值（BNC / 当代语料库词频排名）
WORDROOT_URLS = [
    "https://gh-proxy.com/https://raw.githubusercontent.com/skywind3000/ECDICT/master/wordroot.txt",
    "https://raw.githubusercontent.com/skywind3000/ECDICT/master/wordroot.txt",
]
THESAURUS_URLS = [
    "https://gh-proxy.com/https://raw.githubusercontent.com/zaibacu/thesaurus/master/en_thesaurus.jsonl",
    "https://raw.githubusercontent.com/zaibacu/thesaurus/master/en_thesaurus.jsonl",
]


def download(urls, dest):
    for url in urls:
        try:
            print(f"[dict] 下载 {url}")
            urllib.request.urlretrieve(url, dest)
            if os.path.getsize(dest) > 0:
                return True
        except Exception as e:
            print(f"[dict]   失败: {e}")
    return False


def fetch(name, urls, explicit):
    if explicit:
        return explicit
    cache = os.path.join(tempfile.gettempdir(), "ecdict", name)
    if os.path.isfile(cache) and os.path.getsize(cache) > 1024:
        return cache
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    if not download(urls, cache):
        sys.exit(f"[dict] 无法获取 {name}，请用 --{name.split('.')[0]} 指定本地文件")
    return cache


def build_roots(words, lemma_path_dir):
    """解析 wordroot.txt（JSON），输出 root 索引与 word→roots 倒排。
    例词仅保留已入选词典的词；wordroot 可缺失（旧缓存），缺省返回空。"""
    path = os.path.join(tempfile.gettempdir(), "ecdict", "wordroot.txt")
    if not os.path.isfile(path) or os.path.getsize(path) < 1024:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if not download(WORDROOT_URLS, path):
            print("[dict] wordroot.txt 获取失败，跳过词根索引")
            return {}, {}
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except Exception as e:
        print(f"[dict] wordroot.txt 解析失败，跳过词根索引: {e}")
        return {}, {}

    roots = {}
    word_roots = {}
    for root_id, node in raw.items():
        if not isinstance(node, dict):
            continue
        in_dict = [w for w in node.get("example", []) if isinstance(w, str) and w.strip().lower() in words]
        if not in_dict:
            continue
        root_key = (node.get("root") or root_id).strip().lower()
        if not root_key or root_key in roots:
            continue
        roots[root_key] = {
            "m": node.get("meaning", "").strip(),
            "c": node.get("class", "").strip(),
            "o": node.get("origin", "").strip(),
            "words": sorted({w.strip().lower() for w in in_dict}),
        }
        for w in roots[root_key]["words"]:
            word_roots.setdefault(w, [])
            if root_key not in word_roots[w]:
                word_roots[w].append(root_key)
    return roots, word_roots


def build_synonyms(words):
    """解析 zaibacu/thesaurus（WordNet 提取的 JSONL），输出 word → 同义词列表。
    仅保留同义词也入选词典的条目（保证展示质量），每词上限 6 个。可缺失，缺省返回空。"""
    path = os.path.join(tempfile.gettempdir(), "ecdict", "en_thesaurus.jsonl")
    if not os.path.isfile(path) or os.path.getsize(path) < 1024:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if not download(THESAURUS_URLS, path):
            print("[dict] en_thesaurus.jsonl 获取失败，跳过同义词索引")
            return {}
    synonyms = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    node = json.loads(line)
                except ValueError:
                    continue
                w = str(node.get("word", "")).strip().lower()
                if w not in words:
                    continue
                bucket = synonyms.setdefault(w, [])
                for s in node.get("synonyms", []):
                    s = str(s).strip().lower().replace("_", " ")
                    if s in words and s != w and s not in bucket:
                        bucket.append(s)
    except Exception as e:
        print(f"[dict] 同义词数据解析失败，跳过: {e}")
        return {}
    # 至少 2 个同义词才保留（单条没有聚类价值）
    return {w: s[:6] for w, s in synonyms.items() if len(s) >= 2}


def build_lemma(lemma_path, words):
    """词形还原反查表：inflected → base（仅保留 base 已入选的映射）。

    lemma.en.txt 按 base 的词频降序排列，同一个变形可能挂在多个 base 下
    （is 既在 be 下、也在 i 下；was 在 be 下，文件末尾还有一条 `wa -> was`）。
    必须**先到先得**（setdefault）：保留高频 base；否则末尾那些低频同形词条
    （wa / ha / doe）会覆盖正确映射，查 is 出「i」、查 was 查不到、查 does 出「母鹿」。"""
    lemma = {}
    with open(lemma_path, encoding="utf-8") as f:
        for line in f:
            if line.startswith(";") or "->" not in line:
                continue
            base_part, forms_part = line.split("->", 1)
            base = base_part.split("/")[0].strip().lower()
            if base not in words:
                continue
            for form in forms_part.split(","):
                form = form.strip().lower()
                if form and form.isalpha() and form != base and form not in words:
                    lemma.setdefault(form, base)
    return lemma


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv")
    ap.add_argument("--lemma")
    ap.add_argument("--out", default=os.path.join("resources", "dict", "ecdict-exam.json"))
    ap.add_argument("--lemma-only", action="store_true",
                    help="只重算 lemma 反查表，复用 --out 现有词条与词根/同义词索引")
    args = ap.parse_args()

    lemma_path = fetch("lemma.en.txt", LEMMA_URLS, args.lemma)

    if args.lemma_only:
        with open(args.out, encoding="utf-8") as f:
            data = json.load(f)
        words = data.get("words") or {}
        if not words:
            sys.exit(f"[dict] {args.out} 没有 words，无法只重算词形表")
        data["lemma"] = build_lemma(lemma_path, words)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        size_mb = os.path.getsize(args.out) / 1024 / 1024
        print(f"[dict] 词形表已重算: {len(data['lemma'])} 条映射, {size_mb:.1f} MB -> {args.out}")
        return

    csv_path = fetch("ecdict.csv", CSV_URLS, args.csv)
    print(f"[dict] 词库: {csv_path}\n[dict] 词形表: {lemma_path}")

    words = {}
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        idx = {k: i for i, k in enumerate(header)}
        for row in reader:
            if len(row) < 12:
                continue
            def _i(key, default=0):
                v = row[idx[key]].strip()
                try:
                    return int(v)
                except ValueError:
                    return default
            tags = set(row[idx["tag"]].split())
            is_exam = bool(tags & EXAM_TAGS)
            is_freq = (0 < _i("frq") <= FREQ_LIMIT) or (0 < _i("bnc") <= FREQ_LIMIT)
            if not (is_exam or is_freq):
                continue
            word = row[idx["word"]].strip().lower()
            if not word:
                continue
            words[word] = [
                row[idx["phonetic"]].strip(),
                # ECDICT 的 CSV 把换行存成字面量 "\n"（反斜杠+n），还原成真实换行
                row[idx["translation"]].strip().replace("\\n", "\n"),
                row[idx["definition"]].strip().replace("\\n", "\n"),
                row[idx["tag"]].strip(),
                _i("collins"), _i("oxford"), _i("bnc"), _i("frq"),
                row[idx["exchange"]].strip(),
            ]

    # 词形还原反查表：inflected → base（仅保留 base 已入选的映射）
    lemma = build_lemma(lemma_path, words)

    roots, word_roots = build_roots(words, None)
    synonyms = build_synonyms(words)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"v": 3, "count": len(words), "words": words, "lemma": lemma,
                   "roots": roots, "wordRoots": word_roots, "synonyms": synonyms},
                  f, ensure_ascii=False, separators=(",", ":"))

    size_mb = os.path.getsize(args.out) / 1024 / 1024
    print(f"[dict] 完成: {len(words)} 词, {len(lemma)} 条词形映射, {len(roots)} 个词根"
          f"(覆盖 {len(word_roots)} 词), {len(synonyms)} 词有同义词组, {size_mb:.1f} MB → {args.out}")


if __name__ == "__main__":
    main()
