import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
  bookExists,
  bookIdFromBytes,
  copyOriginFile,
  createBookFromBootstrap,
  refreshBookStatus,
  writeChaptersBatch,
} from './library'
import type { ChapterFile } from '../shared/types'

/**
 * 章节标题行：`第1章` / `第 1 章` / `第1回`，以及楔子、番外这类非编号标题。
 * 「卷 / 部」不算章——它是分组名，单独成章会把目录切得很碎。
 */
const CHAPTER_RE =
  /^[ \t]*(?:第\s*[0-9一二三四五六七八九十百千万零〇两壹贰叁肆伍陆柒捌玖拾佰仟]+\s*[章节回]|楔子|序章|序言|前言|引子|尾声|终章|后记|番外|外传)[^\n]{0,60}$/m

function splitByChapter(text: string): { title: string; body: string }[] {
  const lines = text.split('\n')
  const chapters: { title: string; body: string }[] = []
  let currentTitle = '正文'
  let currentBody: string[] = []

  for (const line of lines) {
    if (CHAPTER_RE.test(line)) {
      if (currentBody.length > 0 || chapters.length === 0) {
        chapters.push({ title: currentTitle, body: currentBody.join('\n').trim() })
      }
      currentTitle = line.trim()
      currentBody = []
    } else {
      currentBody.push(line)
    }
  }
  if (currentBody.length > 0) {
    chapters.push({ title: currentTitle, body: currentBody.join('\n').trim() })
  }
  return chapters.filter((c) => c.body.length > 0)
}

/** 解码坏字的占比：替换符、控制符都算。 */
function badness(text: string): number {
  if (!text.length) return 1
  const sample = text.slice(0, 4000)
  const bad = (sample.match(/[\uFFFD\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) || []).length
  return bad / Math.min(sample.length, 4000)
}

/** 中文小说里的高频字：用来分辨「真中文」和「字节被错解出来的生僻字」。 */
const COMMON_HAN =
  '的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新己制身果加西斯月话合回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走义各入几口认条平系气题活尔更别打女变四神总何电数安少报才结反受目太量再感建务做接必场件计管期市直德资命山金指克许统区保至队形社便空决治展马科司五基眼书非则听白却界达光放强即像难且权思王象完设式色路记南品住告类求据程北边死张该交规万取拉格望觉术领共确传师观清今切院让识候带导争运笑飞风步改收根干造言联持组每济车亲极林服快办议往元英士证近失转夫令准布始怎呢存未远叫台单影具罗字爱击流备兵连调深商算质团集百需价花党华城石级整府离况亚请技际约示复病息究线似官火断精满支视消越器容照须九增研写称企八功吗包片史委乎查轻易早曾除农找装广显吧阿李标谈吃图念六引历首医局突专费号尽另周较注语仅考落青随选列武红响虽推势参希古众构房半节土投某案黑维革划敌致陈律足态护七兴派孩验责营星够章音跟志底站严巴例防族供效续施留讲型料终答紧黄绝奇察母京段依批群项故按河米围江织害斗双境客纪采举杀攻父苏密低朝友诉止细愿千值仍男钱破网热助倒育属坐帝限船脸职速刻乐否刚威毛状率甚独球般普怕弹校苦创假久错承印晚兰试股拿脑预谁益阳若哪微尼继送急血惊伤素药适波夜省初喜卫源食险待述陆习置居劳财环排福纳欢雷警获模充负云停木游龙树疑层冷洲冲射略范竟句室异激汉村哈策演简卡罪判担州静退既衣您宗积余痛检差富灵协角占配征修皮挥胜降阶审沉坚善妈刘读啊超免压银买皇养怀执副乱抗犯追帮宣佛岁航优怪香著田铁控税左右份穿艺背阵草脚概恶块顿敢守酒岛托仓'

function commonHanRatio(text: string): number {
  const sample = text.slice(0, 4000)
  const cjk = (sample.match(/[\u3400-\u9fff]/g) || []).length
  if (cjk === 0) return 0
  let hits = 0
  for (const ch of sample) {
    if (COMMON_HAN.includes(ch)) hits++
  }
  return hits / cjk
}

/** 没有 BOM 的 UTF-16：ASCII 高位字节会是规律分布的 0x00。 */
function detectBomlessUtf16(buf: Buffer): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(buf.length, 4096)
  if (n < 8) return null
  let evenZero = 0
  let oddZero = 0
  for (let i = 0; i < n; i++) {
    if (buf[i] !== 0) continue
    if (i % 2 === 0) evenZero++
    else oddZero++
  }
  const half = n / 2
  if (oddZero / half > 0.3 && evenZero / half < 0.05) return 'utf-16le'
  if (evenZero / half > 0.3 && oddZero / half < 0.05) return 'utf-16be'
  return null
}

function decodeUtf16be(buf: Buffer): string {
  if (buf.length % 2 !== 0) return buf.toString('utf-8')
  const swapped = Buffer.from(buf)
  swapped.swap16()
  return swapped.toString('utf16le')
}

/** 解码结果连同猜到的编码：界面据此提示，用户才知道自己那份文件是怎么被读的。 */
export interface DecodedTxt {
  text: string
  encoding: string
}

/**
 * 逐步尝试各编码，取「坏字最少、且解出来最像中文」的那个。
 * 只看替换符不够：GBK 能把 Big5 字节解成一堆合法但没人用的生僻字，两边都没有替换符。
 */
export function decodeTxtBuffer(buf: Buffer): DecodedTxt {
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.toString('utf16le'), encoding: 'utf-16le' }
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: decodeUtf16be(buf), encoding: 'utf-16be' }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf-8'), encoding: 'utf-8' }
  }

  const bomless = detectBomlessUtf16(buf)
  if (bomless === 'utf-16le') return { text: buf.toString('utf16le'), encoding: 'utf-16le' }
  if (bomless === 'utf-16be') return { text: decodeUtf16be(buf), encoding: 'utf-16be' }

  const candidates: Array<{ encoding: string; text: string }> = [{ encoding: 'utf-8', text: buf.toString('utf-8') }]
  for (const encoding of ['gbk', 'gb18030', 'big5']) {
    try {
      candidates.push({ encoding, text: new TextDecoder(encoding).decode(buf) })
    } catch {
      /* 运行时不支持这个编码就跳过 */
    }
  }

  let winner = candidates[0]
  let winnerScore = { bad: badness(winner.text), han: commonHanRatio(winner.text) }
  for (const candidate of candidates.slice(1)) {
    const score = { bad: badness(candidate.text), han: commonHanRatio(candidate.text) }
    const better = score.bad < winnerScore.bad || (score.bad === winnerScore.bad && score.han > winnerScore.han)
    if (better) {
      winner = candidate
      winnerScore = score
    }
  }
  return { text: winner.text, encoding: winner.encoding }
}

/** Windows 记事本、Word 导出的 txt 都是 CRLF：先统一换行，段落才切得开。 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

export async function importTxt(filePath: string): Promise<{ bookId: string }> {
  const buf = await readFile(filePath)
  const bytes = new Uint8Array(buf)
  const bookId = bookIdFromBytes(bytes)
  if (await bookExists(bookId)) {
    return { bookId }
  }

  const text = normalizeNewlines(decodeTxtBuffer(buf).text)
  const fileName = basename(filePath, extname(filePath))
  const parts = splitByChapter(text)
  const titles = parts.length > 0 ? parts.map((p) => p.title) : [fileName]
  const bodies = parts.length > 0 ? parts.map((p) => p.body) : [text]

  const book = await createBookFromBootstrap({
    bookId,
    title: fileName,
    author: '',
    importType: 'txt',
    chapterTitles: titles,
  })
  await copyOriginFile(bookId, filePath)
  // 一次性批量落盘：上千章逐章写会把同一份 book.json 读写上千次
  await writeChaptersBatch(
    bookId,
    book.chapters.map((ch, i) => ({
      chapterId: ch.id,
      file: { title: titles[i], body: bodies[i] ?? '', status: 'ready' } as ChapterFile,
    })),
  )
  await refreshBookStatus(bookId)
  return { bookId }
}
