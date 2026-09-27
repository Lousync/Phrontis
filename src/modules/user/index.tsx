import { useState, useEffect, useCallback } from 'react'
import { User, Clock } from 'lucide-react'
import type { UserProfile, UserStats } from '../../types'
import { getUserProfile, setUserUsername, getUserStats } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { useSettings } from '../../lib/SettingsContext'
import { AvatarUpload } from './components/AvatarUpload'
import { PasswordSection } from './components/PasswordSection'
import { StatsPanel } from './components/StatsPanel'
import { DataClearSection } from './components/DataClearSection'
import { VaultArchiveSection } from './components/VaultArchiveSection'

export function UserModule() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [stats, setStats] = useState<UserStats | null>(null)
  const [username, setUsername] = useState('')
  const [editing, setEditing] = useState(false)
  const { s, update } = useSettings()

  // ---- Lock screen password（已移除：锁屏功能删除，2026-08-31） ----

  const loadData = useCallback(async () => {
    // 兜底：IPC 异常也要退出加载态（此前无 catch，异常即永远「加载中」——2026-09-08 修复）
    try {
      const [p, s] = await Promise.all([getUserProfile(), getUserStats()])
      setProfile(p ?? { username: '', avatarPath: '', hasPassword: false, createdAt: '', updatedAt: '' })
      setStats(s)
      if (p) setUsername(p.username)
    } catch (err) {
      console.error('[user] 资料加载失败:', err)
      showToast({ type: 'error', message: '账户资料加载失败，请重试' })
      setProfile({ username: '', avatarPath: '', hasPassword: false, createdAt: '', updatedAt: '' })
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const handleSaveUsername = async () => {
    const trimmed = username.trim()
    if (!trimmed) { setUsername(profile?.username || ''); setEditing(false); return }
    await setUserUsername(trimmed)
    setProfile(prev => prev ? { ...prev, username: trimmed } : null)
    setEditing(false)
    showToast({ type: 'info', message: '用户名已更新' })
  }

  const handlePasswordChanged = (hasPwd: boolean) => {
    setProfile(prev => prev ? { ...prev, hasPassword: hasPwd } : null)
  }

  const handleAvatarChanged = (path: string) => {
    setProfile(prev => prev ? { ...prev, avatarPath: path } : null)
  }

  if (!profile) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
        加载中...
      </div>
    )
  }

  const createdAt = profile.createdAt ? new Date(profile.createdAt).toLocaleDateString('zh-CN') : '-'

  return (
    <div className="kb-theme-surface flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-1 border-b border-[var(--border-color)] px-2 py-1 text-[11.5px] text-[var(--text-muted)] shrink-0 select-none">
        <User size={12} />
        用户
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-6 py-8 space-y-8">
          {/* Avatar + Username */}
          <div className="flex items-center gap-6">
            <AvatarUpload
              avatarPath={profile.avatarPath}
              onAvatarChanged={handleAvatarChanged}
            />

            <div className="flex-1 space-y-3">
              {/* Username */}
              <div className="flex items-center gap-2">
                {editing ? (
                  <>
                    <input
                      autoFocus
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                      onBlur={handleSaveUsername}
                      onKeyDown={e => { if (e.key === 'Enter') handleSaveUsername(); if (e.key === 'Escape') { setUsername(profile.username); setEditing(false) } }}
                      placeholder="输入用户名..."
                      className="w-48 px-2.5 py-1.5 bg-[var(--input-bg)] border border-[var(--accent)] rounded text-[15px] font-medium text-[var(--text-primary)] outline-none"
                    />
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <h2
                      className="text-[15px] font-medium text-[var(--text-primary)] cursor-pointer hover:text-[var(--accent)] transition-colors"
                      onClick={() => setEditing(true)}
                      title="点击修改用户名"
                    >
                      {profile.username || '未设置用户名'}
                    </h2>
                    <button
                      onClick={() => setEditing(true)}
                      className="text-[11px] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
                    >
                      编辑
                    </button>
                  </div>
                )}
              </div>

              {/* Password (for import/export) */}
              <PasswordSection
                hasPassword={profile.hasPassword}
                onPasswordChanged={handlePasswordChanged}
              />

              {/* Created at */}
              <div className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
                <Clock size={12} />
                <span>创建于 {createdAt}</span>
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-[var(--border-color)]" />

          {/* Stats */}
          <StatsPanel stats={stats} />

          {/* Divider */}
          <div className="border-t border-[var(--border-color)]" />

          {/* 整仓归档（P6：导出/导入 zip + 冲突逐条决策） */}
          <VaultArchiveSection />

          {/* Danger zone: clear all data */}
          <DataClearSection />
        </div>
      </div>
    </div>
  )
}
