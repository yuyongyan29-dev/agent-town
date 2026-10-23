# Agent 小镇

把本机各个 agent 的实时工作画成一片 3D 微缩小镇：每个 agent 一个街区，街区里每个项目是一间车间，每次工具调用是一件包裹，沿传送带送到中转站，再送到这个 agent 的广场打包发货。内置 Claude Code 与 Codex，其他 agent 用 HTTP 推事件就会自动开出新街区。纯本地运行，只读本机日志，不联网上传任何内容（天气除外）。

## 运行

```bash
npm install
npm start
```

打开 http://localhost:4317 。需要 Node 20+。端口可用 `PORT=xxxx npm start` 改。

数据来源：
- Claude Code：`~/.claude/projects/**/*.jsonl`
- Codex：`~/.codex/sessions/**/*.jsonl`

不装 hook 也能用，靠实时读日志。装了 hook 后，「等你授权」「回合结束」这类状态会更及时：

```bash
npm run hooks:install
```

它会把 hook 合并进 `~/.claude/settings.json` 和 `~/.codex/hooks.json`，保留已有配置，改之前先备份成 `*.agent-town.bak`。卸载用 `npm run hooks:uninstall`。小镇没开时 hook 静默跳过，不影响 agent。

## 接入其他 agent

任何能发 HTTP 的程序都可以推事件到 `POST /api/ingest`（只收本机请求）。agent 名用小写字母、数字、`_.-`，第一次出现时自动在空地开一个街区：

```bash
curl -X POST http://localhost:4317/api/ingest -H 'Content-Type: application/json' -d '{
  "agent": "gemini", "name": "Gemini CLI", "color": "#4aa3df",
  "events": [
    { "sid": "s1", "kind": "turnStart", "cwd": "/path/to/project", "prompt": "跑测试" },
    { "sid": "s1", "kind": "toolStart", "toolId": "t1", "tool": "Bash", "label": "npm test" },
    { "sid": "s1", "kind": "toolEnd", "toolId": "t1" },
    { "sid": "s1", "kind": "turnEnd" }
  ]
}'
```

body 也可以是单个事件或事件数组（每个事件自带 `agent`）。`kind` 常用 `turnStart` / `toolStart` / `toolEnd`（可带 `isError`）/ `wait` / `turnEnd` / `sessionEnd`；`color` 不填会按名字算一个。

支持 hook 的 agent 也可以直接把 hook 的 stdin 转给小镇：在它的 hook 配置里调用 `node scripts/hook.js <agent名>`，事件格式与 Claude Code hooks 相同。

## 看什么

- **车间**：最近活跃的 7 个项目。屋顶信标颜色 = 状态（运行中 / 等你处理 / 需留意 / 刚完成），烟囱冒烟表示在干活
- **包裹**：一次工具调用，颜色按类别（读、写、命令、搜索、子任务、联网、MCP 等）；长时间运行的工具会在车间门口打转，出错的包裹变红掉下传送带
- **中转站 → 广场**：工具结束后包裹送到对应 agent 的托盘，一轮结束打包发货，小人会跳一下
- **天气与昼夜**：昼夜按本机时间；天气默认取北京实况，可用环境变量 `AT_CITY` / `AT_LAT` / `AT_LON` 换成你所在的城市（同一时区时昼夜也按该城市的日出日落）；都可以手动切
- **画布**：拉远后街区变成简化方块，只留名字和状态灯；右下角小地图显示所有街区和当前视野，点一下跳过去
- **性能**：光影全部烘焙，网页不做实时光照；按需渲染，静止时不画，有动画时按需要的帧率画；掉帧时自动降低清晰度

## 功能

- 左侧会话列表：按项目分组，显示正在调用的工具、等待原因、卡住提示；可改名、复制 `claude --resume` / `codex resume` 恢复命令
- 提醒：等你授权、干完了、可能卡住时弹窗；可开声音和系统通知，标签页标题带待处理数
- 详情：模型、权限模式、当前工具、最近错误、工具耗时统计、时间线
- 报表：近 7 / 30 天的轮次、工具调用、tokens、工作分钟，按天按项目
- 定时任务：读取本机 crontab 与 launchd 用户任务
- 派单：在指定目录直接让 Claude Code 或 Codex 跑一条任务（非交互模式）
- 回放：以 10 / 30 / 60 倍速重放最近 1 小时
- 画布：左键拖动平移、右键旋转、滚轮朝光标缩放；Shift + 拖动街区按格子挪位置（存在本机浏览器），街区边挨着边，中间空出的格子自动铺成树林；回到全景会把所有街区框进画面；巡游逐个街区转一圈；鱼缸模式隐藏面板缓慢自转，适合挂副屏

## 画面是怎么做的

模型用 Blender 程序化生成（`tools/bake_town.py`），用 Cycles 把光照、阴影、环境光遮蔽烘焙进贴图，导出成 `public/assets/*.glb`；布局坐标一起导出到 `public/assets/town.json`。网页里所有模型都用不受光照的材质，只显示烘焙好的贴图，不再实时计算光照和阴影；阴天、夜晚在贴图上整体调色，路灯和亮着的窗户单独发光。画面没有变化时不渲染。

改了模型或布局后重新出图（需要装 Blender，平时运行不需要；`--quick` 是低分辨率快速档）：

```bash
npm run assets
```

## 目录

```
server/   日志解析、状态机、SSE、报表、定时任务、派单
scripts/  hook 与 hook 安装脚本
tools/    Blender 建模与烘焙脚本
public/   页面；assets/ 是烘焙好的模型；js/ 下 world（加载模型、街区、天气昼夜）、agents（小人）、parcels（包裹）、hud（面板）、main（入口、画布、小地图）
```

所有时间按本机时区显示和统计。
