# 仓库身份统一（3.9.2）

> 状态：已实现。契约 `.AGENT/scripts/vault-identity/verify-vault-identity.mjs`（39 条 + 5 条变异测试）。

## 问题

`pdfReader` / `readerState` / `excerpts` / `excerptExports` 的键都是 `{rootId}/{relPath}`，而 rootId 只存在**设备级** `settings.json` / `vaults.json` 里，不写进仓库。

结果：同一个仓库在 Windows 和 Linux 各拿一个 rootId，阅读进度、摘录、导出映射分成两套 —— 数据没丢，但互相看不见；书架封面缓存也按 `sha1(bookKey)` 命名，同样分裂。

## 口径

**仓库身份的唯一真相源 = `<vault>/.knowbase/meta.json` 的 `id`。**

- `meta.id` 存在 → 直接采用（无论本机以前用什么 id）。
- `meta.id` 缺失 → 由**第一个打开它的设备**写入本机 id；另一设备打开时采纳它。
- 采纳后同步设备侧：`vaults.json` 按路径去重并改 id；`settings.json` 的 `currentVaultId` / `recentVaults` 由 `setCurrentVault` 按 id **和路径**去重。
- 启动恢复（`loadVaults`）与打开/导入（`adoptVaultDirectory`）都走同一套解析。

## 键迁移

打开仓库时 `migrateVaultIdentity(rootPath, currentId)`：

| 文件 | 合并规则 |
|---|---|
| `modules/pdfReader.json` | 同书键冲突取 `updatedAt` 新 |
| `modules/readerState.json` | 同上 |
| `modules/excerpts.json` | 按摘录 id 求并集；同 id 取 `updatedAt` 新 |
| `modules/excerptExports.json` | 取 `exportedAt` 新 |
| `cache/covers/index.json` | 键换成当前 id；`sha1(newKey).png` 文件同步改名；目标键已存在时保留已有封面、丢弃旧文件 |

- 只处理**UUID 前缀**的键（`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/...`），用户自定义键不动。
- 幂等：迁移后再跑 0 变更；目标已存在不覆盖，只按时间戳合并。
- 失败只记日志，不阻塞打开。

## 回滚

- 代码回退后，数据仍在当前 id 前缀下；旧版只认设备 id，会看不到迁移后的进度（但文件与正文不受影响）。
- `meta.id` 只是新增字段，旧版忽略。

## 已知边界

1. 时间戳是合并依据：两端时钟偏差很大时，可能保留较旧的一侧（概率低）。
2. 若把**另一个仓库**的数据文件手工拷进来，其 UUID 前缀也会被当作历史身份合并 —— 属误用场景。
3. 封面是缓存：即使合并结果不理想，删掉 `.knowbase/cache/covers/` 会按需重建。

## 附带：坏图片引用清理

PDF→Markdown 导入曾写出 `attachment://image.png` 这类**无附件 id** 的引用（文件从未落盘，Windows / Linux 都是破图）。维护脚本：

```bash
# 默认 dry-run
node .AGENT/scripts/vault-maintenance/clean-broken-attachment-refs.mjs --vault "<仓库>"
# 确认后写盘（建议同时备份）
node .AGENT/scripts/vault-maintenance/clean-broken-attachment-refs.mjs --vault "<仓库>" --apply --backup /tmp/refs-backup
```

只删除无效图片语法，保留同一行文字与合法引用（`attachment://<uuid>/`、`attachment://vault/<pageId>/<file>`）。2026-10-19 已在当前仓库执行：12 个文件 / 31 处。

契约：`node --experimental-strip-types .AGENT/scripts/vault-maintenance/verify-refs-cleanup.mjs`（16/16 + 4 条变异测试）。
