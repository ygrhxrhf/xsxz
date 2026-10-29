# U1.1-op-1 实例记录

- 指定 commit：1b86a79890b18c81011271963ea62285abc44c24；实际运行仓库 /home/goot/cod/xs/xsxz；启动前 git rev-parse HEAD 一致。
- 构建：npm run build，退出码 0；产物 index-C60VZKuc.js、index-TQr4WzSQ.css。
- 启动命令：`/home/goot/cod/xs/xsxz/node_modules/electron/dist/electron /home/goot/cod/xs/xsxz --no-sandbox --user-data-dir=/tmp/U1.1-op-1-sNkafk/userData --remote-debugging-port=37461`
- 正式操作实例 Electron 主进程／窗口所属应用 PID：3302921；renderer PID 3303000、3303001，进程参数含独立 userData、CDP 37461、app-path=/home/goot/cod/xs/xsxz。先前夹具准备实例 PID 3290221 已终止，正式 OP 证据均来自重启后的 PID 3302921。
- CDP：http://127.0.0.1:37461；browser websocket：ws://127.0.0.1:37461/devtools/browser/e54baa7e-7609-4aaf-b8d1-a889e9270d45。
- 页面 target：9CB64E8355F8F1D93E18681AE13D7E8D；实际标题「小说浏览器」；地址 file:///home/goot/cod/xs/xsxz/out/renderer/index.html。
- 样例库：/tmp/U1.1-op-1-sNkafk/library；独立 userData 同启动命令；书名「样例·长夜行舟」，作者「样例作者」，三章各 100 段纯文本。预置第二章「第二章 样例长夜」，paragraphIndex=20，scrollRatio=0.25。全部为生成样例，与真实书库隔离。
- 证据位置说明：根证据路径被角色路径守卫阻挡，使用信封允许的 worktree evidence。该 worktree 只承载证据，运行仍来自指定 master commit。
- 窗口：linuxdesktop win_1，应用 electron，实际标题「小说浏览器」，位置 (640,320)，外框1280×800；内容视口1280×771，DPR=1，纸面 x=324..1008、y=24..747，左书脊宽52。desktop_snapshot 同样返回 frame「小说浏览器」。xprop 按名称查询未匹配窗口，未据此更改宿主配置；实际关联依据唯一 electron 主进程和指定 CDP target。
- 页面状态：只操作该实例 file: 阅读页。OP-1 包含一次保留工具状态的书架重入记录及一次同 target 重新载入记录；OP-2 从重新载入的隐藏工具状态开始。OP-4 只点击正文右三分之一，OP-5 只发向下滚轮；scrollTop/clientHeight/scrollHeight 均只读。
- 夹具准备修正：借鉴脚本最初把 ChapterMeta.file 写成0002，运行显示「这一章没有正文」。读取 library.ts 确认 file 为书目录相对路径后，将临时样例改成 chapters/0002.json 等并重启；未改产品。终止旧实例时日志出现 GPU process isn't usable，正式实例启动与全部 OP 期间未出现此错误。
- 实际过程差异保留于 OP-1.md：从已展开工具的书架重入仍可见顶栏和胶囊，重新载入后两者隐藏；两组截图均保留，不作结果判断。
- 截图由指定 CDP Page.captureScreenshot 直接生成，完整1280×771视口，不裁剪、不拼接。*-state.json 包含实际文字、可视段落和只读数值，*-ax.json 为同 target 的 Accessibility.getFullAXTree。bodyText 含非视口段落；章标题滚出屏幕后仅记录为 DOM 标题，不称其仍可见。
- 已执行 OP-1 至 OP-5，未执行项：无。操作证据不含通过或未通过判定。
- 收尾：全部截图与读数保存后主动关闭隔离实例；终止进程树期间 Electron 输出 Network service crashed、zygote communication、GPU process launch failed: error_code=1002、GPU process isn't usable，任务状态 killed/SIGTRAP。错误发生于证据采集后的关闭阶段，未尝试修改权限或图形宿主配置。临时样例目录保留以便复现，实例现已关闭。
- 已核对全部9张 PNG 文件头尺寸均为1280×771；补充 *-ax-excerpt.txt 为实际无障碍树的有名节点文字摘录，原始完整树仍保留。
