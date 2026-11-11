# 真实书籍翻页 seam 验收：复现步骤

本文件给出把 `docs/img/realbook-flip-seam-2026-11-10-flip-{1..4}.png` 这套验收材料
重新生成一遍的完整可执行 PowerShell 序列。每一步都可以单独执行并核对。

**前置条件**

- 在仓库根目录执行（`docs/`、`scripts/` 都在这一层）。
- `scripts/realbook-flip-fps-e2e.mjs` 含「逐带：」输出。该输出**尚未提交**，是工作树改动；
  没有它就无法核对每帧十二条带各自的内容可见度。检查方式：

```powershell
Select-String -Path scripts/realbook-flip-fps-e2e.mjs -Pattern '逐带'
git diff --stat -- scripts/realbook-flip-fps-e2e.mjs
```

第二条命令应有非零改动行数。若为 0 行，说明你在 HEAD 上——HEAD 版本没有逐带输出，
本流程会跑出来但缺少关键判据，请先确认工作树状态。

## 1. 归档旧日志（先备份，再覆写）

```powershell
cd <仓库根目录>
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = 'docs/img/realbook-flip-seam-2026-11-10-run.log'
if (Test-Path $log) { Copy-Item $log "docs/img/realbook-flip-seam-2026-11-10-run.log.bak-$stamp" -Force }
```

`-run.log` 是「当前一轮」的权威来源，带时间戳的 `.bak-*` 是历史轮次。报告正文只引用
不带时间戳的那一份，避免新旧两轮数据混写。

## 2. 构建（截图必须来自当前源码）

```powershell
node node_modules/electron-vite/bin/electron-vite.js build
```

`electron-vite build` 只产出 `out/`，不会重置工作树。

## 3. 慢动作采集四帧

```powershell
$env:SPBF_SLOW_FLIP='1'   # 翻页放慢 10 倍，并把 performance.now 钉在目标进度定格
$env:SPBF_KEEP_SHOTS='1'  # 保留临时截图目录；不设的话收尾会删掉
node scripts/realbook-flip-fps-e2e.mjs > flip-run.log 2>&1
echo "exit=$LASTEXITCODE"
```

`SPBF_SLOW_FLIP=1` 下的照片帧由脚本里的 `frames = [0.45, 0.48, 0.5, 0.52]` 决定，
文件名是 `realbook-flip-${index+1}.png`。四帧对应 t=0.45/0.48/0.50/0.52。

日志经 PowerShell `>` 重定向落盘时，Windows PowerShell 5.1 默认写 UTF-16LE（带 `0xFF 0xFE` BOM），
而 PowerShell 7（`pwsh`）默认写无 BOM 的 UTF-8；下一节先按 BOM 识别编码再统一转存为 UTF-8。

## 4. 日志转码并解析临时截图目录

```powershell
$rawBytes = [System.IO.File]::ReadAllBytes((Resolve-Path 'flip-run.log'))
if ($rawBytes.Length -ge 2 -and $rawBytes[0] -eq 0xFF -and $rawBytes[1] -eq 0xFE) {
  Get-Content 'flip-run.log' -Encoding Unicode | Set-Content -Encoding UTF8 'docs/img/realbook-flip-seam-2026-11-10-run.log'
} else {
  Get-Content 'flip-run.log' -Encoding UTF8 | Set-Content -Encoding UTF8 'docs/img/realbook-flip-seam-2026-11-10-run.log'
}
$shots = Select-String -Path 'docs/img/realbook-flip-seam-2026-11-10-run.log' -Pattern '翻页中截图：' |
         Select-Object -Last 1 -ExpandProperty Line
$dir = [regex]::Match($shots, '([A-Za-z]:\\[^\r\n,]+?spbf-rbfps-shots-[^\\,\s]+)').Groups[1].Value
if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { throw "未解析到有效临时截图目录: $shots" }
echo "临时目录 = $dir"
```

日志中对应的行格式样例（来自 `scripts/realbook-flip-fps-e2e.mjs` 打印的截图列表）：
`翻页中截图：C:\Users\<user>\AppData\Local\Temp\spbf-rbfps-shots-xxxxxx\realbook-flip-1.png, ...`
临时目录里同时有静态书台与书缝特写截图；本流程只归档其中四帧（第 5 节）。

## 5. 只复制四帧到 docs/img

```powershell
foreach ($n in 1..4) {
  Copy-Item -LiteralPath (Join-Path $dir "realbook-flip-$n.png") `
            -Destination "docs/img/realbook-flip-seam-2026-11-10-flip-$n.png" -Force
}
Get-ChildItem docs/img -Filter *flip-*.png | Select-Object Name, Length
```

**不复制** `realbook-seam-static.png`：那是书缝特写，不在本轮四帧归档清单里。

## 6. 哈希核对（归档图必须与临时产物逐字节一致）

```powershell
foreach ($n in 1..4) {
  $a = (Get-FileHash (Join-Path $dir "realbook-flip-$n.png") -Algorithm SHA256).Hash
  $b = (Get-FileHash "docs/img/realbook-flip-seam-2026-11-10-flip-$n.png" -Algorithm SHA256).Hash
  echo "flip-$n match=$($a -eq $b)"
}
```

四行都应为 `match=True`。只要有一行为 `False`，归档图与源码就不是同一份产物，
不要拿去当验收证据。

## 7. 墨迹密度统计（可复算）

```powershell
node scripts/realbook-flip-ink-density.mjs
```

固定口径（定义在 `scripts/realbook-flip-ink-density.mjs` `L20-L42`、`L120-L137`）：
- 亮度 `0.2126R + 0.7152G + 0.0722B < 170`（`INK_LUMINANCE = 170`）记为墨迹；
- `2px` 步长采样（`INK_STEP = 2`，x、y 同一步长），分母 `total` 为该框实际采样的像素数；
- 舍入：`Math.round((1000 * ink) / total) / 10`，以 `.toFixed(1)` 输出一位小数百分比；
- 竖带框 `FRAMES`（取自本轮 `run.log` 三采样行命中区间的并集，纵向 `y 60..620`）：
  帧 1 `x 694..812`（分母 `16860`）、帧 2 `x 615..730`（分母 `16298`）、
  帧 3 `x 523..704`（分母 `25571`）、帧 4 `x 446..698`（分母 `35687`）；
- 正文框 `BODY`：右页 `x 760..1180, y 95..560`（分母 `49163`）。

脚本内部通过 `writeFileSync(OUT_FILE, text, 'utf8')`（`L42`、`L172`）直接覆写
`docs/img/realbook-flip-seam-2026-11-10-ink.txt`，同时把同一份文本回显到终端 `stdout`（`L173-L174`）。
报告引用的全部百分比与分母/命中数都能在该输出文件里逐项找到。

确定性复核（连续运行两次，脚本每次都会重算并覆写 `ink.txt`）：

```powershell
node scripts/realbook-flip-ink-density.mjs
$h1 = (Get-FileHash 'docs/img/realbook-flip-seam-2026-11-10-ink.txt' -Algorithm SHA256).Hash
node scripts/realbook-flip-ink-density.mjs
$h2 = (Get-FileHash 'docs/img/realbook-flip-seam-2026-11-10-ink.txt' -Algorithm SHA256).Hash
echo "stable=$($h1 -eq $h2)"
```

同一份图片、同一版脚本应得到 `stable=True`。

## 8. 归档到 Git

```powershell
git check-ignore -v docs/img/realbook-flip-seam-2026-11-10-flip-1.png   # 应无输出（未被忽略）
git add docs/img/realbook-flip-seam-2026-11-10-flip-1.png `
        docs/img/realbook-flip-seam-2026-11-10-flip-2.png `
        docs/img/realbook-flip-seam-2026-11-10-flip-3.png `
        docs/img/realbook-flip-seam-2026-11-10-flip-4.png `
        docs/img/realbook-flip-seam-2026-11-10-run.log `
        docs/img/realbook-flip-seam-2026-11-10-run.log.bak-* `
        docs/img/realbook-flip-seam-2026-11-10-ink.txt `
        docs/realbook-flip-seam-2026-11-10.md `
        docs/realbook-flip-seam-repro.md `
        scripts/realbook-flip-ink-density.mjs `
        scripts/realbook-flip-fps-e2e.mjs
git status --short
```

`.gitignore` 只忽略 `.multi-agent/**/*.png`，`docs/img` 不受影响；上面第一条命令应打印为空。
第 1 节生成的带时间戳 `.bak-*` 旧日志归档一并纳入 `git add`。

## 清理

```powershell
Remove-Item -Force flip-run.log -ErrorAction SilentlyContinue
```

临时截图目录（`%TEMP%\spbf-rbfps-shots-*`）由脚本自己管理：不设 `SPBF_KEEP_SHOTS=1` 时收尾会删。
留着也行，它不在仓库里。

## 这套流程证不了什么

- 它只跑一套固定的采样帧（0.45–0.52）。其他角域、其他视口宽度、其他 `BEND_DEG` 未覆盖。
- 「逐带：」输出与墨迹密度都是**观察量**。seam 的判据是 84°–91° 角域内的亮度剖面
  （凹陷 ≤ 16/255、不漏桌），不要把这两个数字当验收阈值用。
- 帧号到 t 的映射来自脚本常量，日志里没有 t 值。
