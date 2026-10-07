/**
 * 演示仓示例电子书生成器（阅读器 B 段 · 电子书引擎配套）。
 *
 * 为什么单独造：演示仓 `E:/演示/.books/` 里只有 txt 与 pdf 各一份，EPUB 引擎（foliate）落地后
 * **一本 epub 都没有** —— 书架上看不到新格式，也没法体感侧边点击翻页 / 目录 / 摘录。
 * 探针样书（`probes/make-epub.mjs`）正文是「第 N 段：这是探针样书…」，是**断言靶子**，给人读不合适；
 * 本脚本产出的是**正常中文内容**，三本特征各不相同，覆盖阅读器的不同路径：
 *
 *   阅读器示例-星海拾遗.epub  6 章 · 两级导航（部/章）· 外部 CSS   → 分页 / 目录跳转 / 进度落盘 / 划选摘录 / 侧边点击翻页
 *   阅读器示例-图文笔记.epub  图文混排 · 5 张生成图 · 引用/列表/表格/代码 → 子资源 data: 通道 / 样式渲染
 *   阅读器示例-短章集.epub    16 个短章 · 扁平导航                     → 长目录滚动 / 小节间跳转 / 分页边界
 *
 * 用法（仓库路径口径与 seed-quiz.mjs 一致：第 1 个非 `--` 参数 > `DEMO_VAULT` > `E:/演示`）：
 *   node make-sample-books.mjs                  # 干跑：只校验 + 打印将写入什么（默认不落盘）
 *   node make-sample-books.mjs --write          # 落盘到 <vault>/.books/
 *   node make-sample-books.mjs --write E:/演示  # 指定仓库
 *
 * 复用 `probes/make-epub.mjs` 的 `zipStore()`（EPUB 只允许 STORED，上游已实现且字节可复现），
 * 不重复造 zip 写入；插图走本地极简 PNG 编码器（node:zlib），同样**不引任何依赖**。
 * 产物字节可复现：同一份源码两次生成逐字节相同（zip 时间戳固定 + deflate 参数固定）。
 *
 * ★ 校验内建：**先校验后落盘**，任何一本不过就不写 —— 免得把坏书放进演示仓，
 *   而坏书的表象是「打开书架没反应 / 阅读器空白」，排查起来先怀疑代码。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { zipStore } from '../workbench-shell/probes/make-epub.mjs'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const ROOT = args.find((a) => !a.startsWith('--')) || process.env.DEMO_VAULT || 'E:/演示'
const BOOKS_DIR = path.join(ROOT, '.books')

/* ------------------------------------------------------------------ 插图：极简 PNG 编码器 */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}

/** 8bit 真彩、无滤波、无隔行的最小 PNG —— 只够画示例插图，不是通用编码器 */
function pngRGB(w, h, shade) {
  const stride = w * 3 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    const row = y * stride
    raw[row] = 0 // filter type: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = shade(x / (w - 1), y / (h - 1))
      const o = row + 1 + x * 3
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const byte = (v) => Math.max(0, Math.min(255, Math.round(v)))
const mix = (a, b, t) => [0, 1, 2].map((i) => byte(a[i] + (b[i] - a[i]) * t))

/** 五张程序生成的插图（`u/v` 是 0..1 归一化坐标，与像素尺寸无关） */
const ART = {
  /** 暮色：上深蓝下暖橙的竖直渐变 */
  dusk: (u, v) => mix([18, 28, 58], [232, 146, 92], v),
  /** 窗光：中心偏左上的柔光，向四角落到靛蓝 */
  glow: (u, v) => mix([238, 228, 208], [30, 38, 74], Math.min(1, Math.hypot(u - 0.4, v - 0.55) / 0.66)),
  /** 条纹：斜向双色 */
  stripes: (u, v) => (Math.floor(u * 9 + v * 5) % 2 === 0 ? [222, 116, 88] : [46, 62, 92]),
  /** 色阶：六条水平色带 */
  bands: (u, v) => {
    const ramp = [
      [58, 74, 110], [86, 116, 150], [130, 160, 180], [186, 196, 186], [226, 206, 168], [240, 232, 214],
    ]
    return ramp[Math.min(ramp.length - 1, Math.floor(v * ramp.length))]
  },
  /** 棋盘：两种灰的柔和交替 */
  checker: (u, v) => (Math.floor(u * 8) + Math.floor(v * 5)) % 2 === 0 ? [238, 233, 222] : [176, 192, 206],
}

const art = (name, w = 560, h = 210) => pngRGB(w, h, ART[name])

/* ------------------------------------------------------------------ EPUB 组装 */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const xhtml = (title, body, cssHref = 'style.css') => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="${cssHref}"/></head>
<body>
${body}
</body></html>`

/** 递归生成 nav 的嵌套 `<ol>`（两级足够：部 → 章） */
function navList(items, depth = 0) {
  const pad = '  '.repeat(depth + 1)
  const rows = items.map((it) => {
    const inner = it.items ? `\n${navList(it.items, depth + 1)}\n${pad}` : ''
    return `${pad}  <li><a href="${it.href}">${esc(it.label)}</a>${inner}</li>`
  })
  return `${pad}<ol>\n${rows.join('\n')}\n${pad}</ol>`
}

const navDoc = (toc) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc" id="toc"><h1>目录</h1>
${navList(toc)}
</nav></body></html>`

/**
 * 组装一本 EPUB。
 * @param {{title:string, id:string, creator:string, chapters:Array<{file:string,title:string,body:string}>,
 *          toc:Array<{href:string,label:string,items?:any[]}>, css:string, images?:Array<{name:string,bytes:Buffer}>}} o
 * ★ zip 内的条目名必须全 ASCII（`zipStore` 的 flags 位没置 UTF-8 标志）—— 中文只许出现在文件内容里。
 */
function buildEpub({ title, id, creator, chapters, toc, css, images = [] }) {
  const imgItems = images.map((im, i) => `    <item id="img${i + 1}" href="${im.name}" media-type="image/png"/>`)
  const chItems = chapters.map((c, i) => `    <item id="c${i + 1}" href="${c.file}" media-type="application/xhtml+xml"/>`)
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${id}</dc:identifier>
    <dc:title>${esc(title)}</dc:title>
    <dc:creator>${esc(creator)}</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
${chItems.join('\n')}
${imgItems.join('\n')}
  </manifest>
  <spine>
${chapters.map((c, i) => `    <itemref idref="c${i + 1}"/>`).join('\n')}
  </spine>
</package>`
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  return zipStore([
    ['mimetype', 'application/epub+zip'], // ★ 规范要求：第一个条目且不压缩
    ['META-INF/container.xml', container],
    ['OEBPS/content.opf', opf],
    ['OEBPS/nav.xhtml', navDoc(toc)],
    ['OEBPS/style.css', css],
    ...images.map((im) => [`OEBPS/${im.name}`, im.bytes]),
    ...chapters.map((c) => [`OEBPS/${c.file}`, xhtml(c.title, c.body)]),
  ])
}

/* ------------------------------------------------------------------ 三本示例书 */

/** 一本 · 星海拾遗：6 章中文短篇，两级导航，正文足够长以触发真实分页 */
function bookStarTide() {
  const css = `body { font-family: "Source Han Serif SC", "Songti SC", serif; line-height: 1.9; margin: 0 7%; }
h1 { font-size: 1.45em; margin: 2.2em 0 1em; color: #22314a; }
h2 { font-size: 1.05em; letter-spacing: .28em; color: #8a7a5c; font-weight: normal; margin: 2.6em 0 .6em; }
blockquote { margin: 1.5em 0; padding: .3em 0 .3em 1em; border-left: 3px solid #c9b48b; color: #55606f; }
p { text-indent: 2em; margin: .7em 0; }`

  const part = (t) => `<h2>${t}</h2>`
  const P = (...ps) => ps.map((s) => `<p>${s}</p>`).join('\n')

  const chapters = [
    {
      file: 'ch01.xhtml', title: '第一章 灯塔之外',
      body: `${part('第一部 潮汐')}
<h1>第一章 灯塔之外</h1>
${P(
  '灯塔立在岬角最东端，白色塔身被海风吹得发灰。守塔人换过三代，最后一任把它改成了观测站，只留顶层那盏灯，每晚十点准时亮起。',
  '林晚第一次上去是在九月。风把盐粒拍在玻璃上，一整面窗像是结了薄霜。屋里只有一张桌子、一台旧接收机和一本翻烂的潮汐表。',
  '接收机是老式短波机，编号被漆盖住了。它每天记录十二小时，磁带绕成一个个小圈，像一串没人拆开的信。',
  '白天的工作是维护：给电池加水，把天线转向，把前一晚的磁带编号装箱。编号从一九七九年一直排到现在，中间没有断过。',
  '编号连续这件事让林晚安心。世上大多数东西都在断，档案柜里的这一串却没有。',
  '塔下有一间小屋，是过去守塔人住的。屋顶漏过雨，墙皮一块块往下掉，墙角留着一张铁架床。',
  '林晚在小屋里放了一把椅子和一只水壶。傍晚坐在那里，能看见整个海湾从金色变成灰色。',
  '站长交给林晚的任务简单得可疑：记录噪声，标出异常，别的什么都不要问。这句话写在门背后的白板上，落笔很重，把板面压出了浅浅的凹痕。',
  '规矩不多，但每一条都写在纸上：记录时间精确到秒；磁带不得剪接；夜里不得离塔。',
  '林晚把它们抄进本子，抄到最下面一条时停了很久：如果听见了不该有的东西，写下来，不要回答。',
  '镇上的人对观测站没什么兴趣。他们更关心潮水什么时候退，好去滩上捡螺。',
  '只有老邮差每次上山都要问一句：听见什么了吗。林晚说没有。老邮差就点点头，把报纸放下山去。',
  '后来林晚才明白，那句问话不是寒暄。',
  '头三个星期，林晚听到的全是海。浪、风、远处渔船的对讲、偶尔掠过的电离层回声。噪声像一张毯子，均匀地盖在所有频率上。',
  '她把每天的声音都记成一行：日期、时段、天气、有没有异常。三个星期写下来，本子上全是「无」。',
  '第四个星期的凌晨两点十七分，毯子上破了一个洞。',
  '那声音只有两秒，像有人在很远的地方敲了一下金属。频谱图上它是一条笔直的竖线，没有拖尾，也没有回声。',
  '林晚把磁带倒回去，又放了三遍。第四遍时，窗外那盏灯正好转到最远端，光扫过海面，整片海亮了一瞬。',
  '白板上的那句话，从那天起开始失效。',
)}`,
    },
    {
      file: 'ch02.xhtml', title: '第二章 盐与星图',
      body: `<h1>第二章 盐与星图</h1>
${P(
  '档案柜里有四十年的记录：纸质的潮汐表、油印的天气图、后来是成箱的软盘，最上面一层才是近十年的硬盘。',
  '柜子的钥匙有三把，一把在站长身上，一把挂在墙上，第三把不知去向。',
  '林晚用的是墙上那把。柜门打开时冒出旧纸和铁锈混在一起的味道，像下雨天的仓库。',
  '她先按年份找，再按月份找。找到那一年时，纸页的边缘已经发脆，翻动时要用手掌托着。',
  '「异常」在档案里有专门的表格，栏目只有四列：时间、频率、持续、备注。备注那一栏常年空着。',
  '林晚数了数四十年来填过的异常表，一共二十七张，其中十九张集中在同一年。',
  '十九这个数字，她当时还没有意识到意味着什么。',
  '林晚把「两秒的敲击」列成一张表：出现时间、频率、持续时长、当时的天气。第一版表只有七行。',
  '七行里有五行落在同一个月，且都是满月的凌晨；剩下两行在台风过境的第二天。',
  '站长看完表，只说了一句：把天气那两行划掉。',
  '林晚没有划。夜里的台风尾还没散，观测站摇得像一条船，接收机里全是白色的噪声。凌晨三点，那条竖线又出现了。',
  '这一次它长了一点，四点六秒。竖线两侧多出两片极浅的裙摆 —— 那是调制，自然噪声不会长成那个样子。',
  '林晚把两段录音叠在一起，在时间轴上对齐中心。波形严丝合缝，像同一句话被说了两遍。',
  '她把两段频谱打印出来，用直尺量了两条竖线的间距：误差在半格以内。',
  '老档案里夹着一张手绘星图，纸已经脆了。图上用红笔圈了七个点，三个在观测站正上方，另外四个跨过半个天空。',
  '星图背面写着日期：四十年前的秋天。落款是一个林晚不认识的名字。',
  '那一晚林晚没睡。她把星图摊在桌上，在每个点旁边画了一个小圈，又在圈与圈之间连了两条虚线。',
  '两条虚线交叉的地方，正好落在观测站的位置上。',
  '她抬头看窗外，天已经蒙蒙亮，海面像一块没洗干净的铁板。',
)}`,
    },
    {
      file: 'ch03.xhtml', title: '第三章 静默年',
      body: `<h1>第三章 静默年</h1>
${P(
  '四十年前的秋天，岛上还没有观测站，只有灯塔。那一年在档案里被记作「静默年」：报告写了一半，剩下的页码被人整齐地撕掉了。',
  '撕口很平，是一把好裁纸刀留下的。林晚数了数剩下的页码，缺的正好是九月到十二月。',
  '海图室的钥匙挂在门框上，系着一小截麻绳。屋里有霉味、旧纸味，和一点柴油味。',
  '林晚第一次进去时用手电照了一圈：墙上钉着十几张旧海图，边角卷起，有的用铅笔标过暗礁。',
  '撕掉的四个月里，报告的编号存根还留着：九月三份，十月两份，十一月四份，十二月一份。',
  '十份报告，一份都没留下。存根上是同一个人的笔迹，最后一笔拖得很长。',
  '抽屉最底层躺着一台便携录音机，和观测站的接收机同型号。里面卡着一盘磁带，标签上只写了两个字：潮汐。',
  '磁带转到三分之二时，出现了那条竖线。紧接着是第二次、第三次……一共十九次，间隔均匀，像心跳。',
  '十九次之后是一段人声，非常短，非常轻，像有人贴着麦克风说了一个词。',
  '林晚听了整个下午才确认：那不是任何一门语言里的词，而是一串数字。十九个数字，与十九次敲击一一对应。',
  '她把十九次敲击的时刻抄在方格纸上，一格代表一分钟。画完之后，点排成一串均匀的斜线。',
  '均匀才是最奇怪的地方：自然的东西都有起伏，这串点没有。',
  '数字是坐标。把它们画在海图上，十九个点连成一条折线：从港口出发，绕开暗礁，最后停在正东偏南一百二十海里处。',
  '那是一片没有任何标记的海。',
  '港口的老人说，静默年那年冬天特别暖，海上没结冰，鱼却少得反常。',
  '有人说是外国船在附近放了什么东西，也有人说，是因为那年天上的星星特别亮。',
  '林晚把这些话都记下来，没有写进报告。',
)}`,
    },
    {
      file: 'ch04.xhtml', title: '第四章 拾遗者',
      body: `${part('第二部 回声')}
<h1>第四章 拾遗者</h1>
${P(
  '一百二十海里外什么都没有。卫星图上是一片均匀的深蓝，连一条渔船航迹都找不到。',
  '林晚去镇上找过一个老船长。老船长听完，把茶杯盖扣在桌上，说：那地方我们去过，回来的人把罗盘扔了。',
  '「为什么扔罗盘？」',
  '「因为它一直指着那边。」老船长说完就起身去收网，再没回头。',
  '镇上的旧货铺里堆着十几只罗盘，都用布包好放在箱底。老板说这是「海货」，收得便宜，卖得也便宜。',
  '林晚买了一只，读数正常。回观测站的路上它开始慢慢偏，等到了塔下，指针已经稳稳落在正东偏南。',
  '那天夜里接收机没有响。林晚守着它坐到天亮，灯每十秒扫过一次海面。',
  '天亮时磁带自己转到了尽头，咔哒一声，像谁轻轻合上了门。',
  '白板上多了一行字，不是林晚写的：别用机器听，用你自己。',
  '出海的手续麻烦得多。观测站的船是旧的，两台发动机里只有一台能用。',
  '林晚花了六天准备：淡水、柴油、压缩饼干、备用电台，还有那台便携录音机。',
  '她把星图和海图都封进防水袋，压在水箱下面。',
  '出发前一晚站长来了。他没劝，也没拦，只把一把钥匙放在桌上：海图室的，你带走吧。',
  '林晚说：你知道我要去哪儿。',
  '站长说：我不知道。我只知道四十年前也有人去过，回来的时候少了一个人。',
  '「少了一个人？」',
  '「出去三个，回来两个。登记上写的是失踪。」',
  '出发那天是阴天，海面平得像一块铁板。船开出港湾，岸上的灯一盏一盏弱下去。',
  '开到第四个小时，罗盘的指针开始偏。',
  '第五个小时，电台里出现了那种毯子一样的噪声。',
  '林晚按下录音键，指针在纸上走出一条平直的线。',
  '然后那条竖线出现了。这一次它很长，七秒以上。',
)}`,
    },
    {
      file: 'ch05.xhtml', title: '第五章 归航计算',
      body: `<h1>第五章 归航计算</h1>
${P(
  '船在海上漂了一夜。早上起雾，什么都看不见，只有水拍船壳的声音。',
  '林晚把十九次敲击的节奏用手在膝盖上打了一遍，又打一遍，直到不用数也能跟上。',
  '她发现一个细节：敲击之间的间隔并不完全相等，中间有一次多了半拍。',
  '半拍的位置恰好在第九次和第十次之间 —— 正是那只「手」的第四根指头。',
  '她开始用最笨的办法：把耳朵贴在录音机上，关掉所有的灯。',
  '第七天听见了。那不是声音，是一种压力，像有人隔着水按住耳膜，一松一紧，与那十九次敲击完全一致。',
  '她把十九个数字重新排了一遍：按出现顺序连起来是一条航线，按频率高低连起来是一只手的形状。',
  '手有五个指头，掌心朝外，像在推什么，又像在挥手。',
  '归航是另一件事。她把十九个点反过来走了一遍，算出需要十一天。',
  '淡水只够七天。她在本子上写：到不了，但也回不去 —— 因为罗盘一直指着那边。',
  '第十天下午，她看见了岸。灯塔在岬角上，顶层的灯是灭的。',
  '靠岸时天还没黑。码头上没人，只有老邮差在等送报纸的船。',
  '老邮差看了她很久，说：你听见了。',
  '林晚说：听见了。老邮差说：那就够了。',
  '那天晚上她翻出户籍簿，找到了档案里那个名字：登记为出海失踪，日期正是静默年的十二月。',
  '失踪记录后面贴着一张纸，是他自己写的：我们数了十六天。从第十七天起，灯不再由我们控制。',
  '最后一行被水泡烂了，只能认出两个字：别追。',
  '林晚把那张纸抄了一遍，夹进星图里。夜里她做了个梦，梦见海上有一排灯，从头到尾都是暗的。',
)}`,
    },
    {
      file: 'ch06.xhtml', title: '第六章 星海拾遗',
      body: `<h1>第六章 星海拾遗</h1>
${P(
  '观测站换了新的接收机。老的那台被装进木箱，抬上了阁楼。',
  '换机那天来了两个技术员，测了半天信号，说这里底噪比图纸上高，然后就走了。',
  '林晚没提那十九次敲击。她留下的是另一份记录：完整的波形、那张手绘星图、老船长的话，以及一张写着「别追」的纸。她把它们装进一个信封，封口没有粘。',
  '信封放在白板下面。白板擦干净了，只留一行字：噪声是海在说它自己的事，异常是有人在回答。',
  '那年冬天镇上来了新站长，姓周，三十出头，习惯每天早上绕塔走一圈。',
  '周站长第一次上塔就注意到了门背后那块白板，把板子翻过来，背面用铅笔写着七个坐标。',
  '同一张星图的七个点，一个不多，一个不少。',
  '「这几个字是谁写的？」',
  '「上一任。」林晚说。',
  '后来周站长照着坐标做过一次测算，把结果贴在观测站的公告板上：七个点连成的图形随时间缓慢旋转，周期十九年。',
  '公告板上的纸换过三次，没有人去动它。',
  '那天晚上十点，灯照常亮了。海面上什么都没有，只有一条极细的、笔直的光，从灯塔一直铺到看不见的地方。',
  '林晚后来去了别的城市，在一家做声学的公司上班，每天录各种声音：地铁、空调、雨、人说话。',
  '她学会了不去找异常：异常出现的时候，就记下来，然后继续手上的工作。',
  '偶尔半夜醒来，会听见一声很轻的敲击。',
  '她从不回答。',
)}`,
    },
  ]

  const toc = [
    {
      href: 'ch01.xhtml', label: '第一部 潮汐',
      items: [
        { href: 'ch01.xhtml', label: '第一章 灯塔之外' },
        { href: 'ch02.xhtml', label: '第二章 盐与星图' },
        { href: 'ch03.xhtml', label: '第三章 静默年' },
      ],
    },
    {
      href: 'ch04.xhtml', label: '第二部 回声',
      items: [
        { href: 'ch04.xhtml', label: '第四章 拾遗者' },
        { href: 'ch05.xhtml', label: '第五章 归航计算' },
        { href: 'ch06.xhtml', label: '第六章 星海拾遗' },
      ],
    },
  ]

  return {
    name: '阅读器示例-星海拾遗.epub',
    minChars: 3500, // 长文样书：低于这个数说明章节被改瘦了（分页会退化成每章一屏）
    bytes: buildEpub({ title: '星海拾遗', id: 'sample-startide', creator: '示例内容', chapters, toc, css }),
  }
}

/** 二本 · 图文笔记：图文混排 + 引用 / 有序列表 / 表格 / 代码块，驱动子资源与样式通道 */
function bookIllustratedNotes() {
  const css = `body { font-family: "Source Han Sans SC", "Microsoft YaHei", sans-serif; line-height: 1.85; margin: 0 7%; color: #2b2f36; }
h1 { font-size: 1.35em; margin: 2em 0 .8em; color: #1f4b6b; }
img { max-width: 100%; height: auto; border-radius: 4px; }
figure { margin: 1.4em 0; }
figcaption { font-size: .85em; color: #6b7480; margin-top: .5em; }
blockquote { margin: 1.3em 0; padding: .6em .9em; background: #f4f1ea; border-left: 3px solid #c2a878; color: #4d5560; }
ol, ul { margin: .8em 0 1.2em 1.4em; }
li { margin: .35em 0; }
table { border-collapse: collapse; margin: 1.2em 0; font-size: .92em; }
th, td { border: 1px solid #d8d2c6; padding: .45em .7em; text-align: left; }
th { background: #f4f1ea; }
pre { background: #f6f7f9; border: 1px solid #e2e5ea; border-radius: 4px; padding: .8em 1em; overflow-x: auto; font-size: .88em; }
code { font-family: Consolas, "Courier New", monospace; }`

  const fig = (n, name, cap) =>
    `<figure><img src="${name}" alt="${cap}"/><figcaption>图 ${n} ${cap}</figcaption></figure>`

  const chapters = [
    {
      file: 'ch01.xhtml', title: '序：这本示例用来做什么',
      body: `<h1>序：这本示例用来做什么</h1>
<p>这是一本用于试读的示例书：正文是真的，插图是程序生成的，篇幅不长，但足够把阅读器的日常路径走一遍。</p>
<p>建议的动作顺序：</p>
<ol>
  <li>打开它，用鼠标点一下<b>书页的左边缘和右边缘</b>，看是否翻页</li>
  <li>在侧栏里点目录，跳去中段，再退回来</li>
  <li>选中一段文字划选摘录，右栏应该立刻出现一条</li>
  <li>关掉这个标签，再重新打开 —— 进度应该还停在原处</li>
</ol>
<blockquote>示例不求好看，只求每一个功能都有东西可点。</blockquote>`,
    },
    {
      file: 'ch02.xhtml', title: '一 构图：先把注意力放到一个点上',
      body: `<h1>一 构图：先把注意力放到一个点上</h1>
<p>一张图最先被看见的，永远是它最亮或者最锐的那一小块。构图的工作，就是把这块地方安排在你想让人看的位置上。</p>
${fig(1, 'img-1.png', '暮色渐变：视线自然停在上方最暗与最亮交界处')}
<p>把主体放在三分线上是最省力的做法：视线从左到右扫过去，会在那里停一下，然后才继续走。</p>
<ol>
  <li>先决定画面上最亮的点在哪儿</li>
  <li>再决定视线从哪里进入画面</li>
  <li>最后才收拾其余的边角</li>
</ol>
<blockquote>顺序反过来做，多半会得到一张每个角落都在抢注意力的图。</blockquote>`,
    },
    {
      file: 'ch03.xhtml', title: '二 光线：渐变比反差更难得',
      body: `<h1>二 光线：渐变比反差更难得</h1>
<p>强反差容易拍，也容易看腻；难的是从亮到暗的那一段过渡里，还留着多少细节。</p>
${fig(2, 'img-2.png', '窗光：中心亮、四周落下去，过渡里保留层次')}
<p>同一个场景，不同时间的光，能拍的东西并不一样：</p>
<table>
  <tr><th>时间</th><th>光的性质</th><th>适合拍什么</th></tr>
  <tr><td>清晨</td><td>低角度、偏冷</td><td>纹理与雾</td></tr>
  <tr><td>正午</td><td>顶光、硬</td><td>结构与影子</td></tr>
  <tr><td>黄昏</td><td>低角度、偏暖</td><td>轮廓与色块</td></tr>
</table>
<p>光不是开关，是一段可以慢慢走过去的路。</p>`,
    },
    {
      file: 'ch04.xhtml', title: '三 颜色：饱和度是最后才动的那个旋钮',
      body: `<h1>三 颜色：饱和度是最后才动的那个旋钮</h1>
<p>画面发闷的时候，第一反应往往是加饱和。更稳的做法是先调明度关系 —— 明度对了，颜色自己会活过来。</p>
${fig(3, 'img-3.png', '条纹：两种颜色交替，能看出明度差是否足够')}
<p>下面这张是同一组色相排成的六级明度带。相邻两格若能一眼分开，画面里就不会糊成一片。</p>
${fig(4, 'img-4.png', '色阶：六级明度，从深到浅')}
<p>修图时把饱和度的调整放在最后，是唯一一条几乎不会出错的纪律。</p>`,
    },
    {
      file: 'ch05.xhtml', title: '四 纹理：重复产生节奏',
      body: `<h1>四 纹理：重复产生节奏</h1>
<p>单个元素没什么力量，重复起来就有了节奏。棋盘、砖墙、栏杆、书架，都是同一件事。</p>
${fig(5, 'img-5.png', '棋盘：重复的最小单元')}
<p>重复的用处是让视线有地方可走。打断一处重复，那里就成了视觉落点 —— 一整面规整的墙，只开一扇窗，窗就是主角。</p>
<blockquote>纹理负责留住视线，落点负责告诉视线该停在哪儿。</blockquote>`,
    },
    {
      file: 'ch06.xhtml', title: '五 复盘：一页清单',
      body: `<h1>五 复盘：一页清单</h1>
<p>每次拍完、修完，用一分钟过一遍这五条：</p>
<ol>
  <li>画面里最亮的地方，是我想让人看的地方吗</li>
  <li>视线有入口吗，还是四面都能进</li>
  <li>明度关系够不够分开</li>
  <li>有没有一处重复被打断</li>
  <li>边角里有没有多余的东西</li>
</ol>
<p>如果要把它写进样式表，示例长这样：</p>
<pre><code>/* 示例：让插图自适应正文宽度 */
figure { margin: 1.4em 0; }
figure img { max-width: 100%; height: auto; }
figcaption { font-size: .85em; color: #6b7480; }</code></pre>
<blockquote>这本示例到这里结束 —— 如果目录、翻页、摘录、进度都在，那说明阅读器该有的路径都通了。</blockquote>`,
    },
  ]

  const toc = chapters.map((c, i) => ({ href: c.file, label: c.title.replace(/^([一二三四五]) /, '$1、') }))

  return {
    name: '阅读器示例-图文笔记.epub',
    minChars: 1100, // 图文样书：每节一屏，重点在图片与样式，不求篇幅
    bytes: buildEpub({
      title: '图文笔记（示例）', id: 'sample-notes', creator: '示例内容', chapters, toc, css,
      images: [1, 2, 3, 4, 5].map((n) => ({
        name: `img-${n}.png`,
        bytes: art(['dusk', 'glow', 'stripes', 'bands', 'checker'][n - 1]),
      })),
    }),
  }
}

/** 三本 · 短章集：16 个短章、扁平导航 —— 长目录滚动与小节间跳转 */
function bookShortPieces() {
  const css = `body { font-family: "Source Han Serif SC", "Songti SC", serif; line-height: 1.95; margin: 0 8%; }
h1 { font-size: 1.3em; margin: 1.6em 0 .9em; color: #33404f; }
p { text-indent: 2em; margin: .7em 0; }
hr { border: none; border-top: 1px solid #ddd6c8; margin: 2em 0; }`

  const pieces = [
    ['清晨', ['六点二十，楼下第一班公交进站。窗帘缝里那道光缓慢地移过地板，从床脚移到书桌腿，再爬上一摞没拆的书。', '这个时辰的城市像一张还没写完的纸，谁都可以往上添一笔。']],
    ['雨', ['雨是从中午开始下的，不大，但足够让每个人在出门前多站三秒钟。', '屋檐水落在空调外机上，一声一声，像有人在楼下敲着什么。']],
    ['书桌', ['书桌上永远有三样东西：一杯水、一支笔、一张写着今天要做什么的纸。', '纸上的字迹从早到晚越来越潦草，最后一条通常只写了一个字。']],
    ['巷口', ['巷口那家修鞋摊摆了十九年。摊主换过一次棚布，从蓝色的换成了灰色的。', '他说，来修鞋的人越来越少了，但来聊天的人一直没少。']],
    ['站台', ['站台很长，长到你永远不知道对面那个人是在等车，还是在等人。', '列车进站时带起一阵风，把所有人的衣角往同一个方向翻过去。']],
    ['面馆', ['九点半的面馆只剩两个人。老板娘把最后一锅汤的火关小，坐在门口剥蒜。', '她说关门时间不固定，什么时候没客人了，什么时候关。']],
    ['旧信', ['抽屉里有一封没寄出去的信，邮票已经贴好了，收信人的名字写得比正文工整。', '信里没有重要的事，只讲了那年冬天下了很大的雪。']],
    ['午后', ['午后的光是斜的，把书架上一排书脊的影子投在地板上，一格一格。', '这种时候读什么都好，读不进去也好。']],
    ['猫', ['那只猫每天三点准时出现在窗台上，坐十几分钟，然后走。', '它从不进屋，也从不叫，像是来完成一项没人交给它的工作。']],
    ['图书馆', ['图书馆里最响的声音是翻页。整层楼的人同时翻页时，像一阵很轻的风。', '管理员推着小车从过道过去，轮子在地毯上压出闷闷的声响。']],
    ['耳机', ['耳机里的歌单换了很多次，只有第一首一直没删。', '有些歌不是为了好听，是为了让某个下午和别的下午区分开。']],
    ['雪', ['雪下到后半夜停了。天亮时整条街的轮廓都软了一号。', '最早出门的那个人，在雪地上留下一串笔直的脚印。']],
    ['生日', ['生日那天没有蛋糕，煮了一碗面，加了一个蛋。', '吃完把碗洗了，忽然觉得这一年过得比想象中快，也比想象中稳。']],
    ['搬家', ['搬家时才发现，一个房间里能装下这么多用不上的东西。', '最后装进箱子的是窗帘和一只旧水杯，理由自己也说不清。']],
    ['桥', ['桥不长，走完大概两分钟。中间那一段能同时看见上游和下游。', '有人在桥中央停下拍照，拍完继续走，桥就空了出来。']],
    ['深夜', ['凌晨一点，楼上在拖椅子，声音从天花板传下来，慢慢挪到窗边。', '再过一会儿会安静下来，然后是新的一天，和这一天几乎一样，又略有不同。']],
  ]

  const chapters = pieces.map(([name, ps], i) => {
    const heading = `之${numCn(i + 1)} ${name}`
    return {
      file: `ch${String(i + 1).padStart(2, '0')}.xhtml`,
      title: heading,
      body: `<h1>${heading}</h1>\n${ps.map((s) => `<p>${s}</p>`).join('\n')}`,
    }
  })

  const toc = chapters.map((c) => ({ href: c.file, label: c.title }))

  return {
    name: '阅读器示例-短章集.epub',
    minChars: 900, // 短章样书：每章 1-2 段是刻意的（测长目录滚动与短章分页边界）
    bytes: buildEpub({ title: '短章集（示例）', id: 'sample-pieces', creator: '示例内容', chapters, toc, css }),
  }
}

/** 1..20 的中文数字（本书只用得到 1..16） */
function numCn(n) {
  const d = '零一二三四五六七八九'
  if (n < 10) return d[n]
  if (n === 10) return '十'
  if (n < 20) return `十${d[n - 10]}`
  return `${d[Math.floor(n / 10)]}十${n % 10 ? d[n % 10] : ''}`
}

/* ------------------------------------------------------------------ 校验（先校验后落盘） */

/** 只认 STORED 的 zip 读取器 —— 本脚本写出的产物全是 STORED，无需解压 */
function readStoredEntries(buf) {
  const out = new Map()
  let p = 0
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8)
    const size = buf.readUInt32LE(p + 18)
    const nameLen = buf.readUInt16LE(p + 26)
    const extraLen = buf.readUInt16LE(p + 28)
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8')
    const start = p + 30 + nameLen + extraLen
    if (method !== 0) throw new Error(`条目 ${name} 不是 STORED，本校验器无法读取`)
    out.set(name, buf.subarray(start, start + size))
    p = start + size
  }
  return out
}

/** 取第 1 个捕获组的所有匹配（`pattern` 传正则**源码**，全局标志由本函数加，免得调用方漏写 `/g`） */
const refs = (text, pattern) => [...String(text).matchAll(new RegExp(pattern, 'g'))].map((m) => m[1])

/**
 * 结构自检：manifest / spine / nav / 正文内外引用是否自洽。
 * 断言的是**规范要求**（mimetype 必须是第一个且不压缩、引用必须能解析到条目），
 * 不是为了适配我们自己的生成器 —— 生成器写错了这里就该红。
 */
function verifyBook(book) {
  const problems = []
  // `zipStore()` 返回的是 Uint8Array（不是 Buffer），读多字节整数要先包一层
  const entries = readStoredEntries(Buffer.from(book.bytes))
  const names = [...entries.keys()]
  const textOf = (n) => entries.get(n)?.toString('utf8') ?? ''
  let chars = 0
  let docCount = 0

  if (names[0] !== 'mimetype') problems.push(`第一个条目是 ${names[0]}，规范要求 mimetype`)
  if (textOf('mimetype') !== 'application/epub+zip') problems.push('mimetype 内容不对')
  for (const n of names) if (!/^[\x20-\x7e]+$/.test(n)) problems.push(`条目名含非 ASCII 字符：${n}`)

  const opfPath = refs(textOf('META-INF/container.xml'), 'full-path="([^"]+)"')[0]
  if (!opfPath) problems.push('container.xml 里找不到 rootfile')
  else if (!entries.has(opfPath)) problems.push(`container.xml 指向的 ${opfPath} 不存在`)

  if (opfPath) {
    const opf = textOf(opfPath)
    const dir = path.posix.dirname(opfPath)
    const manifest = [...opf.matchAll(/<item\b[^>]*id="([^"]+)"[^>]*href="([^"]+)"/g)]
    const ids = new Set(manifest.map((m) => m[1]))
    const hrefs = new Set(manifest.map((m) => m[2]))
    for (const href of hrefs) {
      const p = path.posix.normalize(path.posix.join(dir, href))
      if (!entries.has(p)) problems.push(`manifest 的 ${href} 在包里找不到（解析为 ${p}）`)
    }
    const idrefs = refs(opf, 'idref="([^"]+)"')
    if (!idrefs.length) problems.push('spine 是空的')
    for (const id of idrefs) if (!ids.has(id)) problems.push(`spine 的 idref=${id} 不在 manifest 里`)

    // nav：每个 href 都要能落到 spine 里的文档上
    const navHrefs = refs(textOf(`${dir}/nav.xhtml`), 'href="([^"]+)"')
    if (!navHrefs.length) problems.push('nav 里没有目录项')
    for (const href of navHrefs) {
      const bare = href.split('#')[0]
      if (!bare) continue
      if (!hrefs.has(bare)) problems.push(`目录项 ${href} 不在 manifest 里`)
    }

    // 每篇正文：外链资源能解析 + 有实际文本（nav 文档不算正文，它只有目录标题）
    const navItem = [...opf.matchAll(/<item\b[^>]*\/>/g)].map((m) => m[0]).find((t) => t.includes('properties="nav"'))
    const navManifestHref = refs(navItem ?? '', 'href="([^"]+)"')[0]
    for (const href of hrefs) {
      if (!href.endsWith('.xhtml')) continue
      if (href === navManifestHref) continue
      const doc = textOf(path.posix.normalize(path.posix.join(dir, href)))
      docCount += 1
      chars += doc.replace(/<[^>]+>/g, '').length
      for (const ref of refs(doc, '(?:src|href)="([^"]+)"')) {
        if (/^(https?:|data:|#)/.test(ref)) continue
        const p = path.posix.normalize(path.posix.join(dir, ref))
        if (!entries.has(p)) problems.push(`${href} 引用的 ${ref} 找不到（解析为 ${p}）`)
      }
      if (!/<body[\s>]/.test(doc)) problems.push(`${href} 没有 body`)
    }
    if (chars < (book.minChars ?? 800)) {
      problems.push(`全书正文只有 ${chars} 字，低于本书声明的下限 ${book.minChars} —— 多半是章节内容漏了`)
    }
  }

  return { problems, chars, docCount }
}

/* ------------------------------------------------------------------ 入口 */

const books = [bookStarTide(), bookIllustratedNotes(), bookShortPieces()]

let failed = false
console.log(`仓库：${ROOT}`)
console.log(`目标：${BOOKS_DIR}\n`)
for (const b of books) {
  const { problems, chars, docCount } = verifyBook(b)
  const kb = (b.bytes.length / 1024).toFixed(1)
  const brief = `${kb} KB · ${docCount} 篇 · ${chars} 字`
  if (problems.length) {
    failed = true
    console.log(`✗ ${b.name}  ${brief}`)
    for (const p of problems) console.log(`    - ${p}`)
  } else {
    console.log(`✓ ${b.name}  ${brief}`)
  }
}
if (failed) {
  console.error('\n校验未通过，未写入任何文件。')
  process.exit(1)
}

if (!WRITE) {
  console.log('\n干跑结束（默认不落盘）。要写入请加 --write。')
} else {
  fs.mkdirSync(BOOKS_DIR, { recursive: true })
  for (const b of books) {
    const dest = path.join(BOOKS_DIR, b.name)
    const existed = fs.existsSync(dest)
    fs.writeFileSync(dest, b.bytes)
    console.log(`${existed ? '覆盖' : '新建'} ${dest}`)
  }
  console.log('\n完成。书架扫描的是仓库顶层 .books/，重开书架（或重启 dev）即可看到。')
}
