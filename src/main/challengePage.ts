/**
 * 站点验证挑战页（Cloudflare / Turnstile）的识别与重试。
 *
 * 为什么需要：这类站先回一个「请稍候…」的空白挑战页，浏览器把 JS 跑完才下发
 * `cf_clearance` cookie，但**页面本身不会自己刷新**。下载层拿到的就是那份挑战骨架，
 * 提取失败，最后被当成 `Intercepted` 墙暂停——用户什么都没做错，只要重载一次就能进。
 *
 * 实测（Electron 43 / Chrome 150，2026-11-02，www.uaa001.com）：
 * - 首次 loadURL：挑战页，主框架 403，正文 0 链接；
 * - `cf_clearance` 在 **约 11 秒**后下发（按秒轮询实测：8s 时还没有，第 11 秒出现）；
 * - 拿到 cookie 后 reload：正常页面，47 个书目链接；已放行的 partition 再访问直接通过。
 *
 * 所以重试不能等固定时长，要**轮询等待 cookie 落定**，上限给足。
 *
 * 边界：只做「等真实浏览器跑完 + 重载」，不解析 Turnstile 载荷、不伪造 cookie。
 * 需要真人点击的站，自动重载无效，由调用方落到既有的「人在环」暂停。
 *
 * **判据要保守**：把拦截页误判成挑战页只会多花一次等待（无害）；
 * 把正常页误判成挑战页会拖慢每一次下载。真正可靠的只有 Cloudflare 挑战脚本。
 */

/** 第三方挑战服务的脚本来源；正常内容页不会引用，是最硬的信号。 */
const CHALLENGE_SCRIPT_HOSTS = ['challenges.cloudflare.com', 'cdn-cgi/challenge-platform']

/**
 * 挑战页专属标题。刻意收窄：像「安全验证」这种中文标题，站点的拦截残页也常用，
 * 放进来会把 `fixtures/intercepted.html` 这类页面误判成挑战页。
 */
const CHALLENGE_TITLES = [
  'just a moment',
  'attention required',
  'checking your browser',
  'verifying you are human',
  '请稍候',
  'checking if the site connection is secure',
]

/** 挑战页专属话术。同样只收 CF / Turnstile 的标志性句子。 */
const CHALLENGE_TEXT = [
  '正在进行安全验证',
  '正在验证您是否是真人',
  '验证您不是自动程序',
  'verify you are human',
  'checking if the site connection is secure',
  'enable javascript and cookies to continue',
  'needs to review the security of your connection',
]

/**
 * 挑战页没有实质内容。超过这个长度就不再靠标题 / 话术判它——
 * 真挑战页装不下这么多字，而正文页里提到 Cloudflare 不该被当成墙。
 *
 * 门槛定在 120：实测挑战页可见正文 77 字，站点的拦截残页 155 字，两者都短，
 * 靠长度分开它们太脆，所以中文标题类判据干脆不收（见 `CHALLENGE_TITLES`）。
 */
const CHALLENGE_MAX_TEXT_LENGTH = 120

interface ChallengeVerdict {
  challenge: boolean
  /** 命中原因，用于日志与测试断言。 */
  reason?: string
}

/**
 * Cloudflare 放行后会种这个 cookie。它是「挑战已经完成」的唯一可靠信号：
 * 页面本身不会跳转，也没有可监听的事件。
 */
export const CHALLENGE_COOKIE_NAME = 'cf_clearance'

/** 从 HTML 里剥出可读正文，用于「挑战页一定很短」这条判据。 */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function pageTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return match ? match[1].replace(/\s+/g, ' ').trim() : ''
}

/**
 * 判断一份 HTML 是不是站点验证挑战页。
 *
 * 1. 引用了 Cloudflare 挑战脚本 —— 最硬，不看长度；
 * 2. 标题是挑战页专属标题，且页面几乎没内容；
 * 3. 正文含挑战页专属话术，且页面几乎没内容。
 */
export function detectChallengePage(html: string, _url?: string): ChallengeVerdict {
  const raw = html ?? ''
  if (!raw.trim()) return { challenge: false }

  // 1. 挑战脚本来源：最硬的信号
  for (const host of CHALLENGE_SCRIPT_HOSTS) {
    if (raw.includes(host)) return { challenge: true, reason: `script:${host}` }
  }

  const text = visibleText(raw)
  if (text.length >= CHALLENGE_MAX_TEXT_LENGTH) return { challenge: false }

  // 2. 挑战页专属标题（只在页面几乎没内容时才认）
  const title = pageTitle(raw).toLowerCase()
  for (const word of CHALLENGE_TITLES) {
    if (title.includes(word)) return { challenge: true, reason: `title:${word}` }
  }

  // 3. 挑战页专属话术
  const lowered = text.toLowerCase()
  for (const phrase of CHALLENGE_TEXT) {
    if (lowered.includes(phrase)) return { challenge: true, reason: `text:${phrase}` }
  }

  return { challenge: false }
}

/**
 * 等挑战完成的轮询节奏。
 *
 * 实测放行 cookie 在 11 秒左右出现，所以单次等待 6 秒起步太短；
 * 改成每秒看一眼 cookie，总预算 20 秒——足以覆盖实测，又不至于把真判死的站拖太久。
 */
export const CHALLENGE_POLL_INTERVAL_MS = 1000
export const CHALLENGE_POLL_BUDGET_MS = 20000

/** 自动重载的次数上限：一次足够（实测一次即通），多了只是对判死的站反复撞。 */
export const CHALLENGE_MAX_RELOAD = 1

interface ChallengeWaitOptions {
  /** 读当前 partition 是否已有放行 cookie。 */
  hasClearance(): Promise<boolean>
  /** 等待一个时间片；测试可注入立即返回的实现。 */
  wait(ms: number): Promise<void>
  /** 总预算，缺省 `CHALLENGE_POLL_BUDGET_MS`。 */
  budgetMs?: number
  /** 轮询间隔，缺省 `CHALLENGE_POLL_INTERVAL_MS`。 */
  intervalMs?: number
  /** 当前时间；测试注入假时钟用，缺省 `Date.now`。 */
  now?(): number
}

/**
 * 等挑战放行：轮询 `cf_clearance`，出现就返回 true，超预算返回 false。
 *
 * 为什么不固定睡一段时间：挑战耗时随站点难度波动（实测 11 秒，冷启动更久），
 * 固定等待要么白等、要么不够。cookie 才是「可以重载了」的真凭据。
 *
 * 调用方取消时要能打断：`wait` 由调用方注入，取消信号在那边处理。
 */
export async function waitForChallengeClearance(options: ChallengeWaitOptions): Promise<boolean> {
  const budget = options.budgetMs ?? CHALLENGE_POLL_BUDGET_MS
  const interval = options.intervalMs ?? CHALLENGE_POLL_INTERVAL_MS
  const now = options.now ?? Date.now
  const deadline = now() + budget
  for (;;) {
    try {
      if (await options.hasClearance()) return true
    } catch {
      /* 读 cookie 失败按「还没放行」处理，不中断等待 */
    }
    if (now() + interval > deadline) return false
    await options.wait(interval)
  }
}
