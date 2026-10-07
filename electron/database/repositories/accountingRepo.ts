import { ipcMain } from 'electron'
import {
  vaultAccountingTransactionsAll, vaultAccountingCategoriesAll, vaultAccountingAccountsAll,
  vaultAccountingParseJson, vaultAccountingImport,
  vaultAccountingCreate, vaultAccountingUpdate, vaultAccountingDelete,
  vaultAccountingSetAccountBalance, vaultAccountingCreateAccount,
  type CreateTransactionInput, type TransactionRow,
} from '../../lib/kbStore/accountingVaultRepo'
import { broadcastDataChanged } from '../../main/windowBus'

/**
 * 记账 IPC 注册（v3.5.x 新模块）。
 *
 * 真相源在 accountingVaultRepo；这里只做转发 + 写操作后的跨窗口广播
 * （scope 对齐 src/lib/dataChanged.ts 的 'accounting'）。channel 命名对齐 `<模块>:<动作>`。
 * AI 工具（builtinTools）不经 IPC、直接调同一批 repo 业务函数。
 */
export function registerAccountingHandlers(): void {
  ipcMain.handle('accounting:getAll', () => ({
    transactions: vaultAccountingTransactionsAll(),
    categories: vaultAccountingCategoriesAll(),
    accounts: vaultAccountingAccountsAll(),
  }))

  ipcMain.handle('accounting:setAccountBalance', (_e, id: string, initialBalance: number) => {
    const row = vaultAccountingSetAccountBalance(id, initialBalance)
    if (row) broadcastDataChanged('accounting')
    return row
  })

  ipcMain.handle('accounting:createAccount', (_e, name: string, initialBalance: number) => {
    const row = vaultAccountingCreateAccount(name, initialBalance)
    broadcastDataChanged('accounting')
    return row
  })

  ipcMain.handle('accounting:parseJson', (_e, text: string) => vaultAccountingParseJson(text))

  ipcMain.handle('accounting:importJson', (_e, text: string) => {
    const res = vaultAccountingImport(text, 'phone-json')
    if (res.added > 0) broadcastDataChanged('accounting')
    return res
  })

  ipcMain.handle('accounting:create', (_e, input: CreateTransactionInput) => {
    const row = vaultAccountingCreate(input)
    broadcastDataChanged('accounting')
    return row
  })

  ipcMain.handle('accounting:update', (_e, id: string, patch: Partial<TransactionRow>) => {
    const row = vaultAccountingUpdate(id, patch)
    if (row) broadcastDataChanged('accounting')
    return row
  })

  ipcMain.handle('accounting:delete', (_e, id: string) => {
    const ok = vaultAccountingDelete(id)
    if (ok) broadcastDataChanged('accounting')
    return ok
  })
}
