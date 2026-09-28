import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'
import { petGet, petFeed, petPetTouch, petRename, petReset, petSwitchSpecies } from '../../../lib/ipc'
import { useDataChanged } from '../../../lib/dataChanged'
import { useAnchoredMenu } from '../../../lib/useAnchoredMenu'
import type { PetSnapshot, PetSpecies } from '../../../types'

// 立绘（AI 生成像素画，docs/pet-design.md §三；命名 {species}-{stage}-{pose}.png）
import dogBabyBase from '../../../assets/pets/dog-baby-base.png'
import dogBabyHungry from '../../../assets/pets/dog-baby-hungry.png'
import dogBabyLie from '../../../assets/pets/dog-baby-lie.png'
import dogBabyPet from '../../../assets/pets/dog-baby-pet.png'
import dogBabyEat from '../../../assets/pets/dog-baby-eat.png'
import dogAdultBase from '../../../assets/pets/dog-adult-base.png'
import dogAdultHungry from '../../../assets/pets/dog-adult-hungry.png'
import dogAdultLie from '../../../assets/pets/dog-adult-lie.png'
import dogAdultPet from '../../../assets/pets/dog-adult-pet.png'
import dogAdultEat from '../../../assets/pets/dog-adult-eat.png'
import catBabyBase from '../../../assets/pets/cat-baby-base.png'
import catBabyHungry from '../../../assets/pets/cat-baby-hungry.png'
import catBabyLie from '../../../assets/pets/cat-baby-lie.png'
import catBabyPet from '../../../assets/pets/cat-baby-pet.png'
import catBabyEat from '../../../assets/pets/cat-baby-eat.png'
import catAdultBase from '../../../assets/pets/cat-adult-base.png'
import catAdultHungry from '../../../assets/pets/cat-adult-hungry.png'
import catAdultLie from '../../../assets/pets/cat-adult-lie.png'
import catAdultPet from '../../../assets/pets/cat-adult-pet.png'
import catAdultEat from '../../../assets/pets/cat-adult-eat.png'
import cthunBabyBase from '../../../assets/pets/cthun-baby-base.png'
import cthunBabyHungry from '../../../assets/pets/cthun-baby-hungry.png'
import cthunBabyLie from '../../../assets/pets/cthun-baby-lie.png'
import cthunBabyPet from '../../../assets/pets/cthun-baby-pet.png'
import cthunBabyEat from '../../../assets/pets/cthun-baby-eat.png'
import cthunAdultBase from '../../../assets/pets/cthun-adult-base.png'
import cthunAdultHungry from '../../../assets/pets/cthun-adult-hungry.png'
import cthunAdultLie from '../../../assets/pets/cthun-adult-lie.png'
import cthunAdultPet from '../../../assets/pets/cthun-adult-pet.png'
import cthunAdultEat from '../../../assets/pets/cthun-adult-eat.png'

/** 立绘键 → URL（键规范 {species}-{stage}-{pose}.png，与 assets 文件名一一对应） */
const SPRITE_URLS: Record<string, string> = {
  'dog-baby-base': dogBabyBase, 'dog-baby-hungry': dogBabyHungry, 'dog-baby-lie': dogBabyLie, 'dog-baby-pet': dogBabyPet, 'dog-baby-eat': dogBabyEat,
  'dog-adult-base': dogAdultBase, 'dog-adult-hungry': dogAdultHungry, 'dog-adult-lie': dogAdultLie, 'dog-adult-pet': dogAdultPet, 'dog-adult-eat': dogAdultEat,
  'cat-baby-base': catBabyBase, 'cat-baby-hungry': catBabyHungry, 'cat-baby-lie': catBabyLie, 'cat-baby-pet': catBabyPet, 'cat-baby-eat': catBabyEat,
  'cat-adult-base': catAdultBase, 'cat-adult-hungry': catAdultHungry, 'cat-adult-lie': catAdultLie, 'cat-adult-pet': catAdultPet, 'cat-adult-eat': catAdultEat,
  'cthun-baby-base': cthunBabyBase, 'cthun-baby-hungry': cthunBabyHungry, 'cthun-baby-lie': cthunBabyLie, 'cthun-baby-pet': cthunBabyPet, 'cthun-baby-eat': cthunBabyEat,
  'cthun-adult-base': cthunAdultBase, 'cthun-adult-hungry': cthunAdultHungry, 'cthun-adult-lie': cthunAdultLie, 'cthun-adult-pet': cthunAdultPet, 'cthun-adult-eat': cthunAdultEat,
}

/** 品种显示名（切换菜单 + 单一真相源） */
const SPECIES_LABEL: Record<PetSpecies, string> = { dog: '小狗', cat: '小猫', cthun: '小克苏恩' }
const PET_SPECIES_LIST: PetSpecies[] = ['dog', 'cat', 'cthun']

const STAGE_UP_NEED = 120
const CANVAS = 192

type AnimName = 'idle' | 'sleep' | 'eat' | 'happy' | 'shy' | 'refuse'

function isNight(): boolean {
  const h = new Date().getHours()
  return h >= 23 || h < 7
}

/** 姿态优先级：被抚 > 睡觉 > 吃饭 > 升级/拒绝(用基础) > 饥饿 > 无聊 > 常规（proto v11） */
function poseOf(s: PetSnapshot, anim: AnimName): 'base' | 'hungry' | 'lie' | 'pet' | 'eat' {
  if (anim === 'shy') return 'pet'
  if (anim === 'sleep') return 'lie'
  if (anim === 'eat') return 'eat'
  if (anim === 'happy' || anim === 'refuse') return 'base'
  if (s.hunger < 25) return 'hungry'
  if (s.mood < 30) return 'lie'
  return 'base'
}

/** 瞬时动画时长（ms），到点回 idle */
const ANIM_MS: Record<Exclude<AnimName, 'idle' | 'sleep'>, number> = { eat: 1500, happy: 880, shy: 1200, refuse: 800 }
const JUMP_SEQ = [0, -8, -12, -8, 0, -6, -3, 0]

export function PetWidget() {
  const [snap, setSnap] = useState<PetSnapshot | null>(null)
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState('')
  const snapRef = useRef<PetSnapshot | null>(null)
  const animRef = useRef<{ name: AnimName; start: number }>({ name: 'idle', start: performance.now() })
  const imgsRef = useRef<Partial<Record<string, HTMLImageElement>>>({})
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fxRef = useRef<HTMLDivElement>(null)
  const bubbleTimer = useRef<number>(0)
  // 宠物菜单（⋯ 入口）：锚定弹出，外部点击/Esc 关闭由 hook 收口
  const menuBtnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menu = useAnchoredMenu(menuBtnRef, menuRef, 176)
  const closeMenu = menu.close

  snapRef.current = snap
  // canvas 仅在 snap 就绪后才挂载（空态分支提前 return）；渲染循环须随之重跑，否则 rAF 在首帧
  // 拿到 null canvas 直接退出、之后再无 canvas → 立绘永远不画（2026-09-28 探针实锤）
  const ready = snap !== null

  const load = useCallback(() => {
    petGet().then((s) => setSnap(s)).catch(() => { /* 无仓库时控件静默空态 */ })
  }, [])

  useEffect(() => { load() }, [load])
  useDataChanged('pet', load)
  // 衰减兜底轮询：主进程在 pet:get 时结算，这里低频拉取保持数字新鲜
  useEffect(() => {
    const id = window.setInterval(load, 60_000)
    return () => window.clearInterval(id)
  }, [load])

  // 立绘预载
  useEffect(() => {
    for (const [key, url] of Object.entries(SPRITE_URLS)) {
      const im = new Image()
      im.src = url
      imgsRef.current[key] = im
    }
  }, [])

  const showBubble = useCallback((text: string) => {
    const el = document.getElementById('pet-widget-bubble')
    if (!el) return
    el.textContent = text
    el.dataset.show = '1'
    window.clearTimeout(bubbleTimer.current)
    bubbleTimer.current = window.setTimeout(() => { el.dataset.show = '0' }, 1700)
  }, [])

  const spawnHearts = useCallback(() => {
    const wrap = fxRef.current
    if (!wrap) return
    for (let i = 0; i < 4; i++) {
      const h = document.createElement('span')
      h.style.cssText = 'position:absolute;width:7px;height:7px;background:#ff8fa8;border-radius:50% 50% 50% 0;transform:rotate(45deg);pointer-events:none;'
      h.style.left = 60 + Math.random() * 70 + 'px'
      h.style.top = '60px'
      wrap.appendChild(h)
      h.animate(
        [{ transform: 'rotate(45deg) translate(0,0)', opacity: 1 }, { transform: `rotate(45deg) translate(${Math.random() * 24 - 12}px,-46px)`, opacity: 0 }],
        { duration: 750 + i * 120, easing: 'ease-out' },
      ).onfinish = () => h.remove()
    }
  }, [])

  const spawnCrumbs = useCallback(() => {
    const wrap = fxRef.current
    if (!wrap) return
    for (let i = 0; i < 5; i++) {
      const c = document.createElement('span')
      c.style.cssText = 'position:absolute;width:6px;height:6px;border-radius:2px;pointer-events:none;'
      c.style.background = ['#ff9eb5', '#ffd76e', '#8ce0ae'][i % 3]
      c.style.left = 70 + Math.random() * 60 + 'px'
      c.style.top = '80px'
      wrap.appendChild(c)
      c.animate(
        [{ transform: 'translate(0,0)', opacity: 1 }, { transform: `translate(${Math.random() * 40 - 20}px,34px)`, opacity: 0 }],
        { duration: 620, easing: 'ease-in' },
      ).onfinish = () => c.remove()
    }
  }, [])

  // 渲染循环（canvas rAF；reduced-motion 时只画静帧）
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    const draw = (now: number) => {
      const s = snapRef.current
      ctx.clearRect(0, 0, CANVAS, CANVAS)
      if (!s) return
      const a = animRef.current
      const t = now - a.start
      // 瞬时动画到点回 idle
      if (a.name !== 'idle' && a.name !== 'sleep' && t > ANIM_MS[a.name]) {
        a.name = 'idle'; a.start = now
      }
      const sleeping = isNight() && (a.name === 'idle' || a.name === 'sleep')
      let dx = 0, dy = 0
      if (!reduced) {
        if (a.name === 'eat') dy = Math.floor(t / 150) % 2 ? -2 : 1
        else if (a.name === 'happy') dy = JUMP_SEQ[Math.min(JUMP_SEQ.length - 1, Math.floor(t / 110))]
        else if (a.name === 'shy') dx = Math.sin(t / 60) * 2
        else if (a.name === 'refuse') dx = Math.sin(t / 45) * 3 * (1 - t / 800)
        else dy = Math.floor(t / (sleeping ? 900 : 620)) % 2 // 待机呼吸 / 睡觉慢浮
      }
      const pose = poseOf(s, sleeping ? 'sleep' : a.name)
      const stage = s.stage === 0 ? 'baby' : 'adult'
      const img = imgsRef.current[`${s.species}-${stage}-${pose}`] ?? imgsRef.current[`${s.species}-${stage}-base`]
      const size = s.stage === 0 ? 150 : 176
      const off = Math.floor((CANVAS - size) / 2)
      if (img && img.complete && img.naturalWidth) {
        ctx.drawImage(img, off + dx, off + dy, size, size)
      }
      if (sleeping) {
        ctx.fillStyle = '#9db7ff'
        ctx.font = 'bold 14px sans-serif'
        ctx.fillText('Z', CANVAS - 34, 40)
      }
    }
    const loop = (now: number) => {
      draw(now)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [ready])

  // 氛围气泡：状态差时偶发抱怨
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = snapRef.current
      if (!s || Math.random() > 0.015) return
      const a = animRef.current.name
      if (a !== 'idle' && a !== 'sleep') return
      if (s.hunger < 25) showBubble(['肚子咕咕叫了…', '好饿…有吃的吗？', '盯着空碗发呆…'][Math.floor(Math.random() * 3)])
      else if (s.mood < 30) showBubble(['好无聊哦…', '陪我玩玩嘛…', '趴着发呆中…'][Math.floor(Math.random() * 3)])
    }, 1000)
    return () => window.clearInterval(id)
  }, [showBubble])

  const onFeed = useCallback(() => {
    const a = animRef.current.name
    if (a === 'eat' || a === 'happy' || a === 'shy' || a === 'refuse') return
    const s = snapRef.current
    if (s && s.hunger >= 92) {
      animRef.current = { name: 'refuse', start: performance.now() }
      showBubble('唔…吃不下了，饱～')
      return
    }
    animRef.current = { name: 'eat', start: performance.now() }
    spawnCrumbs()
    petFeed().then((next) => {
      setSnap(next)
      if (next.stageUp) {
        animRef.current = { name: 'happy', start: performance.now() }
        showBubble('我长大啦！')
      } else {
        showBubble('真好吃！')
      }
    }).catch(() => showBubble('…好像没吃到'))
  }, [showBubble, spawnCrumbs])

  const onTouch = useCallback(() => {
    const a = animRef.current.name
    if (a === 'eat' || a === 'happy' || a === 'shy' || a === 'refuse') return
    animRef.current = { name: 'shy', start: performance.now() }
    spawnHearts()
    petPetTouch().then((next) => {
      setSnap(next)
      if (next.stageUp) {
        animRef.current = { name: 'happy', start: performance.now() }
        showBubble('我长大啦！')
      } else {
        showBubble(['嘿嘿…', '好痒好痒～', '最喜欢你啦！'][Math.floor(Math.random() * 3)])
      }
    }).catch(() => { /* 忽略 */ })
  }, [showBubble, spawnHearts])

  const commitRename = useCallback(() => {
    setEditing(false)
    const name = draftName.trim()
    if (!name) return
    petRename(name).then(setSnap).catch(() => { /* 忽略 */ })
  }, [draftName])

  /** 切换品种（狗⇄猫）：保留进度，只换皮肤 + 该品种自己的名字 */
  const onSwitchSpecies = useCallback((sp: PetSpecies) => {
    closeMenu()
    if (snapRef.current?.species === sp) return
    animRef.current = { name: 'happy', start: performance.now() }
    petSwitchSpecies(sp).then((next) => {
      setSnap(next)
      showBubble(`你好，我是${next.name}！`)
    }).catch(() => { /* 忽略 */ })
  }, [closeMenu, showBubble])

  /** 重新养一只：重置数值与当前品种的名字（另一只的名字保留） */
  const onResetPet = useCallback(() => {
    closeMenu()
    animRef.current = { name: 'idle', start: performance.now() }
    petReset(snapRef.current?.species ?? 'dog').then((next) => {
      setSnap(next)
      showBubble('重新出发～')
    }).catch(() => { /* 忽略 */ })
  }, [closeMenu, showBubble])

  // 空态：无仓库 / 主进程未就绪
  if (!snap) {
    return (
      <div className="flex h-full w-full items-center justify-center px-3 text-center text-[11.5px] text-[var(--text-muted)]">
        打开一个仓库后，桌宠才会住进来～
      </div>
    )
  }

  const stageLabel = snap.stage === 0 ? '幼年' : '成年'
  const expText = snap.stage === 0 ? `${snap.exp} / ${STAGE_UP_NEED}` : '满成长'
  const hungerColor = snap.hunger < 25 ? '#ef6b6b' : '#4cc38a'

  return (
    <>
      <div className="flex h-full w-full flex-col select-none">
        {/* 顶部工具条：互动按钮 + 宠物菜单入口（2026-09-28 布局改版：内容整体贴底，空位改放操作） */}
        <div data-wb="petToolbar" className="flex shrink-0 items-center gap-1.5 px-2 pt-2">
          <button
            className="flex items-center gap-1 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2.5 py-1 text-[11.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
            onClick={onTouch}
          >✋ 摸摸头</button>
          <button
            className="flex items-center gap-1 rounded-lg border border-[var(--accent)] bg-[var(--accent)] px-2.5 py-1 text-[11.5px] font-semibold text-white transition-colors hover:opacity-90"
            onClick={onFeed}
          >🍎 喂食</button>
          <button
            ref={menuBtnRef}
            data-wb="petMenuBtn"
            onClick={menu.toggle}
            title="宠物菜单"
            className={`ml-auto rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${menu.open ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : ''}`}
          ><MoreHorizontal size={14} /></button>
        </div>

        {/* 中部留白：吃掉剩余高度，把底部组压到最下（同时是气泡浮出的空间） */}
        <div className="min-h-0 flex-1" />

        {/* 底部组：立绘 + 名字/阶段/成长 + 状态条（整体贴底） */}
        <div data-wb="petBottom" className="flex shrink-0 flex-col items-center gap-1.5 px-2.5 pb-2.5">
          <div className="relative">
            <div id="pet-widget-bubble" className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 rounded-lg bg-[#33384a] px-2.5 py-1 text-[11.5px] text-white opacity-0 transition-opacity duration-150 data-[show='1']:opacity-100 after:absolute after:left-1/2 after:top-full after:-translate-x-1/2 after:border-[5px] after:border-transparent after:border-t-[#33384a] after:content-['']" />
            <canvas ref={canvasRef} width={CANVAS} height={CANVAS} className="cursor-pointer" style={{ imageRendering: 'pixelated', maxWidth: '100%' }} title="点它摸摸头" onClick={onTouch} />
            <div ref={fxRef} className="pointer-events-none absolute inset-0" />
          </div>

          <div className="w-full flex items-center gap-2">
            {editing ? (
              <input
                autoFocus
                className="min-w-0 flex-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[12.5px] font-semibold text-[var(--text-primary)] outline-none"
                value={draftName}
                maxLength={8}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => { if (e.key === 'Enter') commitRename() }}
              />
            ) : (
              <span className="text-[13.5px] font-semibold text-[var(--text-primary)] cursor-pointer" title="点击改名" onClick={() => { setDraftName(snap.name); setEditing(true) }}>{snap.name}</span>
            )}
            <span className="rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] font-semibold text-[var(--accent)]">{stageLabel}</span>
            <span className="ml-auto text-[10.5px] text-[var(--text-muted)]">{expText}</span>
          </div>

          <div className="w-full flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[10.5px] text-[var(--text-muted)]">
              <span className="w-8 text-right">饱食</span>
              <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"><i className="block h-full rounded-full transition-[width] duration-300" style={{ width: snap.hunger + '%', background: hungerColor }} /></div>
              <span className="w-6 text-right tabular-nums">{Math.round(snap.hunger)}</span>
            </div>
            <div className="flex items-center gap-2 text-[10.5px] text-[var(--text-muted)]">
              <span className="w-8 text-right">心情</span>
              <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"><i className="block h-full rounded-full bg-[#ff8fa8] transition-[width] duration-300" style={{ width: snap.mood + '%' }} /></div>
              <span className="w-6 text-right tabular-nums">{Math.round(snap.mood)}</span>
            </div>
            {snap.stage === 0 && (
              <div className="flex items-center gap-2 text-[10.5px] text-[var(--text-muted)]">
                <span className="w-8 text-right">成长</span>
                <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"><i className="block h-full rounded-full bg-[#f5b83d] transition-[width] duration-300" style={{ width: Math.min(100, snap.exp / STAGE_UP_NEED * 100) + '%' }} /></div>
                <span className="w-6 text-right" />
              </div>
            )}
          </div>

          <div className="text-[10.5px] text-[var(--text-muted)]">活跃度 +{Math.round(snap.activity * 100)}%</div>
        </div>
      </div>

      {/* 宠物菜单（⋯ 入口）：切换宠物 / 改名 / 重新养一只 */}
      {menu.open && menu.pos && createPortal(
        <div
          ref={menuRef}
          data-wb="petMenu"
          className="fixed z-50 w-[176px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-2xl"
          style={menu.pos}
        >
          <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] tracking-wider text-[var(--text-muted)]">切换宠物</div>
          {PET_SPECIES_LIST.map((sp) => (
            <button
              key={sp}
              data-pet-species={sp}
              onClick={() => onSwitchSpecies(sp)}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-[6px] text-left text-[12px] hover:bg-[var(--bg-hover)] ${snap.species === sp ? 'bg-[var(--accent)]/10' : ''}`}
            >
              <img src={SPRITE_URLS[`${sp}-baby-base`]} alt="" className="h-6 w-6 shrink-0" style={{ imageRendering: 'pixelated' }} />
              <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{SPECIES_LABEL[sp]}</span>
              {snap.species === sp && <span className="text-[var(--accent)]">✓</span>}
            </button>
          ))}
          <div className="my-1 border-t border-[var(--border-color)]" />
          <button
            data-wb="petMenuRename"
            onClick={() => { closeMenu(); setDraftName(snap.name); setEditing(true) }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-[6px] text-left text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >✏️ 改名</button>
          <button
            data-wb="petMenuReset"
            onClick={onResetPet}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-[6px] text-left text-[12px] text-[#e06c75] hover:bg-[var(--bg-hover)]"
          >↺ 重新养一只</button>
        </div>,
        document.body,
        'pet-menu',
      )}
    </>
  )
}
