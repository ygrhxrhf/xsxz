/**
 * 页面内探测：`outerHTML` 拿不到的东西，让页面自己说出来。
 *
 * 下载走的是隐藏视图 + `executeJavaScript('document.documentElement.outerHTML')`。
 * 这份序列化里**没有**：Shadow DOM 内容、iframe 内容、挂在 window 上的小说数据
 * （`__NUXT__`、`__NEXT_DATA__`、站点自定义全局）。而付费墙恰好常用这三种藏正文。
 *
 * 做法：拿到 HTML 后补跑一次探测，把结果作为一段 `<script type="application/json">`
 * 拼回 HTML。后面的解锁逻辑照旧扫 `<script>` 就能吃到，不需要额外通道。
 * 探测只回纯文本数组——不把 JSON/HTML 结构当正文丢给下游。
 */

export const PAGE_PROBE_SCRIPT_ID = 'spbf-page-probe'

/** 在页面上下文执行，返回 JSON 字符串。 */
export const PAGE_PROBE_SCRIPT = `(() => {
  var MIN = 60;
  var MAX_STRINGS = 60;
  var out = { shadow: [], frames: [], state: [] };
  var push = function (bucket, text) {
    if (typeof text !== 'string' || text.length < MIN) return;
    if (bucket.length >= MAX_STRINGS) return;
    bucket.push(text.slice(0, 200000));
  };
  var collect = function (value, depth) {
    if (out.state.length >= MAX_STRINGS || depth > 12 || value === null || value === undefined) return;
    if (typeof value === 'string') { push(out.state, value); return; }
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length && i < 40; i++) { try { collect(value[i], depth + 1); } catch (e) {} }
      return;
    }
    if (typeof value === 'object') {
      var keys = [];
      try { keys = Object.keys(value); } catch (e) { return; }
      for (var k = 0; k < keys.length && k < 80; k++) {
        try { collect(value[keys[k]], depth + 1); } catch (e) {}
      }
    }
  };
  var walk = function (root, depth) {
    if (depth > 6) return;
    var nodes = [];
    try { nodes = root.querySelectorAll('*'); } catch (e) { return; }
    for (var i = 0; i < nodes.length; i++) {
      var shadow = null;
      try { shadow = nodes[i].shadowRoot; } catch (e) { shadow = null; }
      if (shadow) {
        push(out.shadow, shadow.textContent || '');
        walk(shadow, depth + 1);
      }
    }
  };
  try { walk(document, 0); } catch (e) {}
  try {
    var frames = document.querySelectorAll('iframe,frame');
    for (var f = 0; f < frames.length; f++) {
      var text = '';
      try {
        var doc = frames[f].contentDocument;
        text = doc && doc.body ? (doc.body.innerText || doc.body.textContent || '') : '';
      } catch (e) { text = ''; }
      push(out.frames, text);
    }
  } catch (e) {}
  try {
    var KEY_RE = /chapter|content|read|novel|book|story|data|state|page|payload/i;
    var names = Object.keys(window);
    for (var n = 0; n < names.length; n++) {
      var name = names[n];
      if (!KEY_RE.test(name) || name.indexOf('webkit') === 0) continue;
      try { collect(window[name], 0); } catch (e) {}
    }
  } catch (e) {}
  return JSON.stringify(out);
})()`

interface ProbeBuckets {
  shadow: string[]
  frames: string[]
  state: string[]
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
}

/**
 * 把探测结果并回 HTML。没有东西可并时原样返回——探测不该改变正常页面的形状。
 */
export function mergePageProbe(html: string, probeJson: string): string {
  const json = (probeJson ?? '').trim()
  if (!json || json === '{}' || json === 'null' || !json.startsWith('{')) return html
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return html
  }
  if (!parsed || typeof parsed !== 'object') return html
  const raw = parsed as Partial<ProbeBuckets>
  const buckets: ProbeBuckets = {
    shadow: asStrings(raw.shadow),
    frames: asStrings(raw.frames),
    state: asStrings(raw.state),
  }
  if (buckets.shadow.length + buckets.frames.length + buckets.state.length === 0) return html

  // JSON 内的 `<` 转成 \u003c：既避免提前闭合 script，也仍是合法 JSON
  const safe = json.replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e')
  const tag = `<script id="${PAGE_PROBE_SCRIPT_ID}" type="application/json">${safe}</script>`
  const close = html.lastIndexOf('</body>')
  if (close >= 0) return `${html.slice(0, close)}${tag}${html.slice(close)}`
  return `${html}${tag}`
}
