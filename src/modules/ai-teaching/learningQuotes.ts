/**
 * 空态励志标语池（2026-11-22 用户拍板）
 *
 * 用途：AI 教学中栏空态的大标题位，替代原来的状态播报（「本段开始 / 开始对话」）。
 * 规则：
 *   · 与学习有关的中外名言（论语 / 礼记 / 荀子 / 唐宋诗文 / 近现代 / 英文）；
 *   · **每一段取到的不一样**：用段 id（或会话 id）做稳定哈希，同一段永远同一句，
 *     不同段落到池子里不同位置；换会话 / 换段就换一句。
 *   · 纯函数、零依赖，方便契约脚本直接 import 校验。
 *
 * 出处只保留最小标识（书名号或人名），不放生卒年与译本说明 —— 空态不是文献页。
 */

export interface LearningQuote {
  /** 标语正文（不含出处） */
  text: string
  /** 出处：书名（《论语》）或作者名（韩愈 / Benjamin Franklin） */
  source: string
}

export const LEARNING_QUOTES: ReadonlyArray<LearningQuote> = [
  // ---- 论语 / 礼记 / 荀子 ----
  { text: '学而时习之，不亦说乎', source: '《论语》' },
  { text: '学而不思则罔，思而不学则殆', source: '《论语》' },
  { text: '知之者不如好之者，好之者不如乐之者', source: '《论语》' },
  { text: '敏而好学，不耻下问', source: '《论语》' },
  { text: '三人行，必有我师焉', source: '《论语》' },
  { text: '温故而知新，可以为师矣', source: '《论语》' },
  { text: '玉不琢，不成器；人不学，不知道', source: '《礼记》' },
  { text: '学然后知不足，教然后知困', source: '《礼记》' },
  { text: '博学之，审问之，慎思之，明辨之，笃行之', source: '《礼记》' },
  { text: '不积跬步，无以至千里', source: '《荀子》' },
  { text: '锲而不舍，金石可镂', source: '《荀子》' },
  { text: '青，取之于蓝，而青于蓝', source: '《荀子》' },
  // ---- 唐宋与诸子 ----
  { text: '业精于勤，荒于嬉', source: '韩愈' },
  { text: '书山有路勤为径，学海无涯苦作舟', source: '韩愈' },
  { text: '读书破万卷，下笔如有神', source: '杜甫' },
  { text: '问渠那得清如许？为有源头活水来', source: '朱熹' },
  { text: '读书之法，在循序而渐进，熟读而精思', source: '朱熹' },
  { text: '少年易老学难成，一寸光阴不可轻', source: '朱熹' },
  { text: '纸上得来终觉浅，绝知此事要躬行', source: '陆游' },
  { text: '旧书不厌百回读，熟读深思子自知', source: '苏轼' },
  { text: '博观而约取，厚积而薄发', source: '苏轼' },
  { text: '非学无以广才，非志无以成学', source: '诸葛亮' },
  { text: '非淡泊无以明志，非宁静无以致远', source: '诸葛亮' },
  { text: '黑发不知勤学早，白首方悔读书迟', source: '颜真卿' },
  { text: '学如逆水行舟，不进则退', source: '《增广贤文》' },
  { text: '读书百遍，其义自见', source: '《三国志》' },
  { text: '千里之行，始于足下', source: '《老子》' },
  { text: '九层之台，起于累土', source: '《老子》' },
  { text: '路漫漫其修远兮，吾将上下而求索', source: '屈原' },
  // ---- 近现代 ----
  { text: '为中华之崛起而读书', source: '周恩来' },
  { text: '好好学习，天天向上', source: '毛泽东' },
  { text: '读书是学习，使用也是学习', source: '毛泽东' },
  // ---- 英文（保持原文）----
  { text: 'An investment in knowledge pays the best interest.', source: 'Benjamin Franklin' },
  { text: 'Live as if you were to die tomorrow. Learn as if you were to live forever.', source: 'Mahatma Gandhi' },
  { text: 'Learning never exhausts the mind.', source: 'Leonardo da Vinci' },
  { text: 'I am still learning.', source: 'Michelangelo' },
  { text: 'Genius is one percent inspiration and ninety-nine percent perspiration.', source: 'Thomas Edison' },
  { text: 'The expert in anything was once a beginner.', source: 'Helen Hayes' },
  { text: 'Knowledge is power.', source: 'Francis Bacon' },
  { text: 'Tell me and I forget. Teach me and I remember. Involve me and I learn.', source: 'Benjamin Franklin' },
  { text: 'The mind is not a vessel to be filled, but a fire to be kindled.', source: 'Plutarch' },
  { text: 'Education is the most powerful weapon which you can use to change the world.', source: 'Nelson Mandela' },
  { text: 'Anyone who stops learning is old, whether at twenty or eighty.', source: 'Henry Ford' },
  { text: 'The more that you read, the more things you will know.', source: 'Dr. Seuss' },
  { text: 'Study hard what interests you the most.', source: 'Richard Feynman' },
  { text: 'The only true wisdom is in knowing you know nothing.', source: 'Socrates' },
  { text: 'The beautiful thing about learning is that no one can take it away from you.', source: 'B.B. King' },
  { text: 'Education is not the filling of a pail, but the lighting of a fire.', source: 'W. B. Yeats' },
]

/**
 * 稳定哈希（djb2）：同一 key 永远取同一句，换段 / 换会话就换一句。
 * 不用 Math.random —— 每次渲染都变会闪，且切回同一段应该还是刚才那句。
 */
export function quoteIndexFor(key: string, length: number = LEARNING_QUOTES.length): number {
  if (length <= 0) return 0
  let h = 5381
  for (let i = 0; i < key.length; i += 1) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0
  return h % length
}

/** 取标语；空 key 落到池子第一句 */
export function pickLearningQuote(key: string): LearningQuote {
  return LEARNING_QUOTES[quoteIndexFor(key || 'welcome')]
}
