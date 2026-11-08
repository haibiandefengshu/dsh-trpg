# dsh-trpg

QQ 群 AI 跑团（CoC 7e）的 **DSH 侧大脑**。骰子、血量、SAN、线索、战斗先手全部由这里算；
DSH 只负责按状态把结果写成小说。

> **必须与 Roost 插件 `trpg-forwarder` 一起使用。** 只装一个不会有人回话。

```
群消息 → Roost(trpg-forwarder) → POST :17322/trpg/event        → 本插件
        本插件 → POST :8080/api/plugins/trpg-forwarder/r/send  → Roost → 群
```

两边配置里的**共享令牌必须一致**。当前版本会自动双向对齐（见「令牌同步」）。

---

## 安装

```bash
dsh plugin add dsh-trpg          # 或插件市场里搜 dsh-trpg
```

装完先做一件事：**填共享令牌**。设置 → 插件 → dsh-trpg → `token`，填一个够长的随机串，
再把 Roost 面板里 `trpg-forwarder` 的「共享令牌」填成同一个值。

不填会怎样：`/trpg/event`、`/trpg/state` 一律返回 `503 token_not_configured`。
这是故意的 —— 空令牌不是「开箱可用」，是「本机任何进程都能让守密人花你的模型额度说话」。

## 配置

DSH 设置 → 插件 → dsh-trpg：

| 字段 | 默认 | 说明 |
|---|---|---|
| `token` | *（空）* | 共享令牌，必须与 Roost 的 trpg-forwarder 一致 |
| `port` | `17322` | 本插件监听端口，Roost 的「dsh-trpg 地址」指向它 |
| `roostSendUrl` | `http://127.0.0.1:8080/api/plugins/trpg-forwarder/r/send` | 出站端点。**端口是 Roost 面板的**，不是 DSH 的 |
| `roostAccessKey` | *（空）* | Roost 面板设了 `webui.accessKey` 才需要填 |
| `agentPreset` | `trpg-keeper` | 守密人用的 DSH 预设 |
| `batchWindowMs` / `maxBatch` | 6000 / 6 | 合批窗口与上限 |
| `turnBudget` | 8 | 单回合最多直发几条消息 |
| `workspaceDir` | *（空）* | 跑团会话的工作区；空 = `~/.dsh/dsh-trpg/workspace` |
| `moduleId` | `mist-harbor` | 下一次 `/trpg start` 用哪个模组 |
| `helpText` | *（空）* | `/帮助` 回复的内容；空 = 内置版本（管理页可改） |

设置页的改动写入 `~/.dsh/dsh-trpg/config.json`，启动时覆盖 bundle 里的 config 行。

## 自检

```bash
curl http://127.0.0.1:17322/trpg/health
curl "http://127.0.0.1:17322/trpg/state?group=<群号>" -H "x-trpg-token: <token>"
```

`/trpg/health` 免令牌，返回端口、运行时长、会话数、正在结算的群数。

---

## 群里怎么用

```
/开始 或 /trpg start      # 开局（建 DSH 会话、载入模组）
/录卡 亚瑟 hp12 san65 侦查70
我推开门走进去             # 直接说话 = 行动，不用 @
```

骰子先单独播报一条，剧情随后到。

### 命令表

`/` 或 `.` 开头都行，中英文都认（英文原样保留，老习惯不用改）。

| 中文 | 等价 | 作用 |
|---|---|---|
| `/开始` `/开局` `/继续` | `/trpg start` | 开局 / 接着上次 |
| `/暂停` | `/trpg pause` | 暂停，状态保留 |
| `/结束` `/结团` | `/trpg end` | 结团 |
| `/重开` | `/trpg restart` | 重开当前模组（角色卡保留） |
| `/重置` | `/trpg reset` | 清空本群跑团数据 |
| `/模组 <id>` | `/trpg module <id>` | 换模组（场景重置、角色卡保留） |
| `/状态` `/团` | `/trpg status` | 看进度 |
| `/录卡 亚瑟 hp12 san65 侦查70` | `/st …` | 录入角色卡 |
| `/建卡` | `/st new` | 再建一张 |
| `/角色卡` `/卡` | `/pc` | 看自己的卡 |
| `/切换角色 P2` | `/pc use P2` | 换一张演 |
| `/解绑` | `/pc release` | 解除绑定 |
| `/检定 侦查 [困难｜奖励1｜惩罚1]` | `/ra …` | 技能检定 |
| `/骰 3d6` | `/r 3d6` | 自由掷骰：`3d6`、`1d100+5`、`4d6k3`、`dh/dl`、四则与括号 |
| `/理智 0/1d6` | `/sc …` | 理智检定 |
| `/幸运` | `/luck` | 花幸运改判 |
| `/房规 <0-5>` | `/setcoc <0-5>` | 大成功 / 大失败边界 |
| `/撤销` | `/undo` | 回滚上一回合 |
| `/记录 <内容>` | `/note <内容>` | 记一条战役事实 |
| `/战术` `/暂离` | `/tactic` `/afk` | 战斗姿态 / 暂时离线 |
| `/帮助` `/指令` | `/help` | 看提示 |

**加命令要同时改三处**，漏一处命令就到不了：

1. `src/commands.js` 的 `CN_ALIASES`（解析）
2. `src/impl.js` 的 `COMMAND_TABLE`（管理页展示）
3. `trpg-forwarder/index.js` 的 `TRPG_CMDS`（桥的准入白名单）

### 单聊也能用

Roost 转发器同时接住群聊（`group`）和单聊（`c2c`）。单聊的会话键是对方 openid，
回复走 `api.sendC2C` —— 单聊里能正常开团、择优、检定。

## 角色卡

| 命令 | 作用 |
|---|---|
| `/录卡 亚瑟 hp12 san65 侦查70` | 建卡（自己已有卡时是更新） |
| `/建卡 备用卡 hp8 san40` | 再建一张（不覆盖，默认不绑定） |
| `/角色卡` | 列出本群所有卡，标出你当前演的那张 |
| `/切换角色 P2` | 切到你演 P2（会从原卡解绑） |
| `/解绑` | 解除绑定（卡保留） |

一个 openid 在同一个群只绑一张卡；未绑定用 NULL 表示，所以一个群可以有多张没人演的卡。

数值范围 **0..99**（CoC 上限），`hp/mp/san` 不超过各自的 max。

## 模组

| id | 名称 | 幕数 |
|---|---|---|
| `mist-harbor` | 雾港旧宅 | 6 |
| `midnight-express` | 午夜列车 | 4 |

两种切换方式等价：设置页的 `moduleId` 下拉，或群里 `/模组 midnight-express`。
内置模组启动即入库，切换只改 `module_id` 与 `current_scene`，不用重启。

自定义模组：管理页「导入模组」上传 `.json`，或群里 `/trpg module` 看列表后指定。

```json
{
  "id": "my-mod",
  "title": "自定义模组",
  "opening": "开场白……",
  "scenes": [
    { "sceneId": "start", "title": "第一幕", "desc": "……",
      "clues": [{ "id": "c1", "cond": "【侦查】", "secret": "……" }],
      "exits": [{ "sceneId": "hall", "label": "里屋" }] }
  ]
}
```

模组是不可信输入：id 只允许字母数字 `_` `-`（2~40 字），title 截断 80、desc 2000、secret 500。
坏文件跳过并记日志，**不会**让插件起不来。

## 开团 / 继续 / 重开

`/trpg start` 分三种情况：

| 输入 | 行为 |
|---|---|
| 没有团 | 建团 + 念开场白 |
| 团在跑 | 「本团正在跑（第 N 回合）」，不重念 |
| 团已暂停/结束 | **继续**：报进度 + 触发一轮接续叙事，不重念开场白 |

继续时喂给模型的提示会显式声明「不要重念开场白」，指令原文不会混进【本轮调查员行动】。
`/重开` 才会回到第 1 回合并重新念开场。

---

## 管理页

`http://127.0.0.1:17322/trpg/admin`（`/` 同）—— 宿主直接渲染的 HTML，不依赖 DSH 前端。
**不受跨域限制**，是排障时的保底入口。

四块，前两块默认折叠：

```
▸ 设置   [令牌已配置]                     模组 雾港旧宅
▸ 指令   共 22 条
雾港调查小队  [running]  GROUP_ALPHA…      ← 数据常显，每团各自折叠
```

### 设置（折叠）

共享令牌、默认模组（+ 导入模组）、工作区目录、指令提示。改完保存立即生效。

### 指令（折叠）

全部命令的中英对照，按 开局 / 角色卡 / 检定 / 其他 分组。

### 跑团数据（每个团各自折叠，防剧透）

收起时只显示可公开的概要：群名、状态、openid、模组名、回合数、调查员人数。

展开后才显示 —— 场景描述、角色数值（HP/MP/SAN/幸运进度条、移动/体格/伤害加值、
状态标签、技能、物品）、剧情进度（线索逐条，未解锁带「剧透」角标）、战役记忆、删除按钮。

### 删除跑团记录

每个团展开后右上角有「删除」按钮，二次确认后删掉该团的角色卡、回合快照、战役记忆。

`trpg_scenes` 不删 —— 它存的是模组定义，多个群共用一份。

## 侧边栏入口

插件加载后左上角侧边栏多一个**跑团面板**图标，点开是整页面板（可滚动容器）。

靠两个槽位对上：

| 槽位 | 注册 |
|---|---|
| `sidebar.panellist` | `{ id: 'dsh-trpg', order: 20, label: () => '跑团面板' }` |
| `main` | `{ key: 'dsh-trpg' }` |

图标组件只接收 `{ size }`，**纯装饰** —— 点击和选中态由侧边栏自己按 id 找同 key 的面板。

插件详情页里那块配置面板（`plugins.bundle.config`）保留，两处渲染同一个组件。

## 指令提示可配置

管理页「设置 → 指令提示」填什么，群里 `/帮助` 就回什么；留空用内置版本（中英对照）。
保存立即生效，写入 `config.json` 的 `helpText`。

---

## 令牌同步（双向）

两边令牌不一致时，群里会彻底没反应 —— 而两边各自看配置都「正常」，这也是最难查的一类故障。

| 方向 | 通道 | 时机 |
|---|---|---|
| DSH → Roost | `PATCH /r/config` + `POST /r/reload` | 在面板/管理页改令牌时 |
| Roost → DSH | `GET /r/token` | 每次 `/trpg/event` 到达时（`await`，10 秒缓存） |

改完会告诉你结果：成功说打到哪个 base，失败说清是哪一步（`config` / `reload` / `network`）。

⚠️ **`/r` 是 Roost 的固定前缀，不能省。**
`ctx.registerRoute('PATCH', '/config')` 实际挂在 `/api/plugins/trpg-forwarder/r/config`。
少写这个 `r` 就是 404 `{"error":"接口不存在"}` —— 看起来像「对方没这个接口」，其实是路径拼错。

拉取分两档：

| 时机 | 行为 |
|---|---|
| 启动 / 保存后 | 只提示不一致，**不覆盖** |
| `/trpg/event` 到达 | **覆盖**（以 Roost 为准） |

启动就覆盖会有副作用：「DSH 刚改成新值、推送失败」时重启会被旧值悄悄盖回去，
用户看到「改了又变回去了」。而事件路径不一样 —— 那条请求本身就是 Roost 用它的令牌发来的。

## 出站配额

同一条 `msg_id` 最多被动回复 5 次。每条用到 4 次就换池里的下一条，池空了改发主动消息。

出站实例**按群隔离**（`Map<groupKey, outbound>`）—— 两个群同时跑团时 turn 与预算互不干扰。
早期是全局单例，A 群结算完会让 B 群的播报直接 return，骰子静默消失。

## 部署前提：Roost 面板设了访问密钥时

Roost 面板的 `/api/*` 都在鉴权之后（`webui.accessKey` 非空才校验），下行 `/send` 也在其中：

| 面板 accessKey | dsh-trpg 需要做什么 |
|---|---|
| 空（本机默认） | 什么都不用做 |
| 已设 | 填 `roostAccessKey`，插件在 `/send` 上带 `x-access-key` |

`401 {"error":"访问密钥无效"}` 是**访问密钥**问题，`bad_token` 才是**共享令牌**问题，两者要分开看。

---

## 排障

### 面板显示「连不上 dsh-trpg」

浏览器里 `fetch` 抛 `TypeError: Failed to fetch`，只有四种可能，按概率排：

| # | 原因 | 特征 | 处理 |
|---|---|---|---|
| 1 | 响应缺 CORS 头（**含 4xx**） | 连 403 都变网络失败 | 头必须在鉴权**之前**挂 |
| 2 | sandboxed iframe 的 `Origin: null` | 服务端日志是 `bad_origin` | 放行 `null`，回 `ACAO: null` |
| 3 | Private Network Access | **服务端一条日志都没有**，预检带 `Access-Control-Request-Private-Network` | 回 `Access-Control-Allow-Private-Network: true` |
| 4 | 真连接失败 | 端口未监听 / 混合内容 | 查进程与协议 |

前三条都已经在代码里处理。面板还会做一次 `no-cors` 探测，把结论直接写进错误行。

### 群里发指令没反应

按顺序查：

```bash
# 1. Roost 有没有把消息转过来
tail -5 "$ROOST/logs/bots/main/plugins/trpg-forwarder.log"

# 2. DSH 有没有收到
curl http://127.0.0.1:17322/trpg/health

# 3. 两边令牌是否一致
curl http://127.0.0.1:8080/api/plugins/trpg-forwarder/r/token
```

日志里有 `已投递 …（/开始）` 但群里没回复 → 下行断了，看 `直发失败` 那行。
日志里连 `已投递` 都没有 → 命令不在桥的 `TRPG_CMDS` 里，或中间件把它放行给了 ai-chat。

### 工具只挂上 5 个

`plugin.log` 里 `成功 5/6` 且失败项是 `trpg_combat_tracker`：
嵌套的 `type: 'object'` 节点缺 `additionalProperties`。`deepFixSchema()` 递归补齐后是 6/6。

### 热重载

`src/host.js` 是薄入口：每次 `apply()` 用新时间戳重新 `import('./impl.js?t=…')`，
所有内部模块带同一个 `STAMP`。改完 `src/*.js` 只需在插件页把开关拨一次，不用重启 DSH。

`dispose` 里会关 server、停 batcher/turnRunner、清出站实例、关 SQLite。
ESM 缓存本身回收不了（这是热重载的代价），但实例持有的资源会放掉。

---

## 数据与文件

```
~/.dsh/dsh-trpg/
├── trpg.sqlite      # 会话、角色卡、场景、快照、战役记忆
├── config.json      # 管理页/设置页写入的覆盖值（含 token）
├── plugin.log       # 挂工具、回合失败、异常
├── modules/         # 导入的自定义模组
└── workspace/       # 跑团会话的工作区（未指定时）
```

重置某一群：管理页删掉那个团，或群里 `/重置`。

## 测试

```bash
cd dsh-trpg && npm test        # node --test --test-concurrency=1
```

覆盖：Host/Origin 校验、CORS 优先顺序、令牌双向同步、`/r` 路径、单聊、权限位、
数值收敛、模组归一化、schema 递归、管理页内联脚本语法。

## 踩过的坑（值得记住的）

| 现象 | 真因 |
|---|---|
| 面板永远 `Failed to fetch`，服务端无日志 | CORS 头在鉴权**之后**才挂；以及 sandboxed iframe 的 `Origin: null` 被 `new URL()` 判错 |
| 令牌同步永远 404 | 漏了 Roost 的 `/r` 前缀 |
| 管理页按钮全都没反应 | 模板字符串里的 `\n` 落进 `<script>` 变成跨行字符串 → 整个脚本语法错误 |
| `/开始` 一条都到不了 | 桥的 `TRPG_CMDS` 没同步 |
| 私聊指令无效 | 中间件只认 `msg.kind === 'group'` |
| 两群并发跑团骰子消失 | outbound 是全局单例，A 群 `endTurn()` 让 B 群 `broadcast()` 直接 return |
| 工具只挂上 5 个 | 嵌套 object 缺 `additionalProperties` |
| 插件整个起不来 | 模组缺 `moduleId` 撞 SQLite 绑定；`warn` 在 `loadUserModules()` 之后定义踩 TDZ |
