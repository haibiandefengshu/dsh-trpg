# dsh-trpg

QQ 群 AI 跑团（CoC 7e）的 **DSH 侧大脑**。骰子、血量、SAN、线索、战斗先手全部由这里算；
DSH 只负责按状态把结果写成小说。

> **必须与 Roost 插件 `trpg-forwarder` 一起使用。**
> Roost 负责 QQ 网关与出站序号（`msg_seq`），本插件负责状态与叙事，两者之间是一条
> 单向上行 + 单向下行：
>
> ```
> 群消息 → Roost(trpg-forwarder) → POST :17322/trpg/event → 本插件
>        本插件 → POST :8080/api/plugins/trpg-forwarder/r/send → Roost → 群
> ```
>
> 两边配置里的**共享令牌必须完全一致**。只装一个不会有人回话。

## 安装

```bash
# 装进当前 DSH 配置（插件市场里搜 dsh-trpg 也行）
dsh plugin add dsh-trpg
```

装完先做一件事：**填共享令牌**。设置 → 插件 → dsh-trpg → `token`，填一个够长的随机串，
再把 Roost 面板里 `trpg-forwarder` 的「共享令牌」填成同一个值。

不填会怎样：本插件的上下行端点直接返回 `503 token_not_configured`，Roost 那边一直投递失败。
这是故意的——空令牌不是「开箱可用」，是「本机任何进程都能让守密人花你的模型额度说话」。

## 配置

DSH 设置 → 插件 → dsh-trpg 里可直接改：

| 字段 | 默认 | 说明 |
|---|---|---|
| `token` | *（空）* | 共享令牌，必须与 Roost 的 trpg-forwarder 一致。**空值会让 `/trpg/event`、`/trpg/state` 一律返回 503**，装完请先填一个 |
| `port` | `17322` | 本插件监听端口，Roost 的「dsh-trpg 地址」要指向它 |
| `roostSendUrl` | `http://127.0.0.1:8080/api/plugins/trpg-forwarder/r/send` | 出站端点（面板端口被占用时按实际端口改） |
| `agentPreset` | `trpg-keeper` | 守密人用的 DSH 预设 |
| `batchWindowMs` / `maxBatch` | 6000 / 6 | 合批窗口与上限 |
| `turnBudget` | 8 | 单回合最多直发几条消息 |

## 自检

```bash
curl http://127.0.0.1:17322/trpg/health
curl "http://127.0.0.1:17322/trpg/state?group=<群号或openid>" -H "x-trpg-token: <token>"
```

## 群里怎么用

```
/trpg start          # 开局（会建 DSH 会话、载入内置模组「雾港旧宅」）
/st 亚瑟 hp12 san65 侦查70
我推开门走进去        # 直接说话 = 行动，不用 @
```

骰子会先单独播报一条，剧情随后到；`/undo` 回滚上一回合，`/luck` 花幸运改判。

## 切换模组

两种方式，等价：

1. **设置页**：设置 → 插件 → dsh-trpg → `moduleId` 下拉。新开的团（`/trpg start`）用这个模组。
2. **群里**：`/trpg module` 看列表，`/trpg module midnight-express` 立刻切换（场景重置到入口，角色卡保留）。

内置两个模组：

| id | 名称 | 幕数 |
|---|---|---|
| `mist-harbor` | 雾港旧宅 | 6 |
| `midnight-express` | 午夜列车 | 4 |

所有内置模组在插件启动时就入库了，切换只改 `module_id` 与 `current_scene`，不用重启。

## 工作区目录

设置 → 插件 → dsh-trpg → `workspaceDir`。跑团会话会建在这个目录下（DSH 的 workspace），
留空表示 `~/.dsh/dsh-trpg/workspace`。改完对**之后新建**的会话生效；已有会话沿用原目录。

## 角色卡

| 命令 | 作用 |
|---|---|
| `/st 亚瑟 hp12 san65 侦查70` | 建卡（自己已有卡时是更新） |
| `/st new 备用卡 hp8 san40` | 再建一张卡（不覆盖已有的，默认不绑定） |
| `/pc` | 列出本群所有卡，标出你当前演的那张 |
| `/pc use P2` | 切换到你演 P2（会把你从原来的卡上解绑） |
| `/pc release` | 解除绑定（卡保留） |

一个 openid 在同一个群里只绑一张卡；「未绑定」用 NULL 表示，所以一个群可以有多张没人演的卡。

## 热重载结构

`src/host.js` 只是**薄入口**：每次 `apply()` 用一个新的时间戳重新 `import('./impl.js?t=…')`，
实现里所有相对导入也带同一个时间戳（各文件顶部的 `STAMP`）。所以改完 `src/*.js`
只需要在插件页把 bundle 关开一次，不用重启整个 DSH。

（首次从旧结构切过来仍需重启一次：旧模块已经在进程里缓存了。）

## 可视化面板

插件 → **dsh-trpg** 详情页描述下方就是「跑团面板」，数据来自本机 `127.0.0.1:17322`：

面板端点同样要求共享令牌：第一次打开先在下图那一栏填一次（存在浏览器 localStorage，
不上传、不回显），服务端从不返回令牌明文。

- 状态：构建戳、运行时长、正在结算的群数
- 共享令牌：改完立即生效（和 Roost 的 trpg-forwarder 对齐）
- 模组：下拉切换，下一次 `/trpg start` 使用
- 工作区目录：对之后新建的会话生效
- 进行中的团与角色卡：哪个群、什么模组、第几回合、谁演哪张卡

保存写在 `~/.dsh/dsh-trpg/config.json`，插件启动时覆盖 bundle 里的 config 行。

## 从 trpg-dice 借鉴的改进

参考 `QQ Agent/resources/app/plugins/trpg-dice`：

| 借鉴点 | 落地位置 |
|---|---|
| 完整骰子表达式（3d6 / 1d100+5 / 4d6k3 / dh·dl / 四则与括号） | `src/dice.js` |
| 全角规范化（３ｄ６ 也能用） | `dice.js#normalize` |
| 骰数与面数硬上限（99999d6 直接拒绝） | `dice.js` |
| `.` 前缀也能当命令 | `commands.js` + `trpg-forwarder` |
| 当场报数、不进模型（接管） | 转发器中间件 halt |
| `/r`、`/sc`、`/jrrp`、`/help` | `commands.js` |
| 奖惩骰 `/ra 侦查 奖励1` | `commands.js` |

没做的：牌堆抽卡、DND 先攻、nWoD 骰池、七版 COC 人物作成（需要额外数据表，留作后续）。

## 掷骰播报（对齐 trpg-dice）

工具注册曾经整批失败（`parameters.type must be a value schema object`），
表现就是「AI 只会叙事、永远不掷骰」。现在 `shapeTool()` 会把扁平参数表转成
标准 JSON Schema（`additionalProperties: false`），并补齐 `output.render`。

播报格式参考 trpg-dice：

```
🎲 亚瑟 的【锁匠】检定：1d100=34/45 【常规成功】
（奖励1（十位[30,40] 个位4）→ 34）
· 撬抽屉
```

| 借鉴点 | 实现 |
|---|---|
| 奖惩骰十位明细 | `rollWithBonus().detail` |
| 房规 0~5（大成功/大失败边界） | `successLevel(roll, skill, houseRule)` + `/setcoc N` |
| 无卡也能掷 | 按技能基础值做临时检定，播报注明未录卡 |
| 派生值 HP/MP/移动/体格/DB | `derivedOf()`，`/pc` 里显示 |
| `/trpg tools` 诊断 | 列出 6 个工具与注册提示 |

## 会话命名

跑团会话的标题统一为 **`群名 · 模组名`**（例：`雾港调查小队 · 雾港旧宅`）。

- 群名由 Roost 转发器随事件带上来（`msg.groupName`）；拿不到时退成 `群` + 群号后 6 位
- 新建会话时立即 `sessionController.rename` 一次
- 每轮开头比对标题，换过模组或标题为空就顺手纠正
- `/trpg module <id>` 切换后当场改名，不用等下一轮

## 开团 / 继续 / 重开

`/trpg start` 以前不分情况一律念开场白，暂停后再发会被当成「团被重开了」。现在分三种：

| 输入 | 行为 |
|---|---|
| `/trpg start`（没有团） | 建团 + 开场白 |
| `/trpg start`（团在跑） | 「本团正在跑（第 N 回合）」，不重念 |
| `/trpg start`（团已暂停/结束） | **继续**：报进度 + 触发一轮接续叙事，不重念开场白 |
| `/trpg pause` | 暂停，消息交回普通聊天 |
| `/trpg end` | 结团（状态 idle，上下文保留） |
| `/trpg restart` | 重开当前模组（角色卡保留，回合归 1，念开场白） |

继续时喂给模型的提示会显式声明「不要重念开场白」，并且**指令原文不会**混进【本轮调查员行动】。

## 出站配额

同一条 `msg_id` 最多被动回复 5 次。现在每条用到 4 次就换池里的下一条，池用空则改发主动消息；
以前池用空后会一直重试最后一条，日志刷 `seq_exhausted` 且消息发不出去。

## 部署前提：Roost 面板设了访问密钥时

Roost 面板的所有 `/api/*` 都在鉴权之后（`webui.accessKey` 非空才校验）。
下行 `/send` 也在这个前缀下，所以：

| 面板 accessKey | dsh-trpg 需要做什么 |
|---|---|
| 空（本机默认） | 什么都不用做 |
| 已设 | 设置页填 **`roostAccessKey`**，插件会在 `/send` 请求上带 `x-access-key` |

不填的表现是 `401 {"error":"访问密钥无效"}` —— 这**不是**共享令牌写错（那会返回 `bad_token`），
两者要分开看。

## 管理页（0.14）

`http://127.0.0.1:17322/trpg/admin`（`/` 同）—— 宿主直接渲染的 HTML，不依赖 DSH 前端。

页面分两部分：

**上半：「设置」折叠块**（默认收起，点标题展开；summary 上带令牌状态与当前模组）

| 项 | 说明 |
|---|---|
| 共享令牌 | 改完立即生效，并自动同步给 Roost 侧的 trpg-forwarder |
| 默认模组 | 下拉选择；右侧「导入模组」可上传 `.json` |
| 工作区目录 | 留空用 `~/.dsh/dsh-trpg/workspace`，对新建会话生效 |

**下半：跑团数据**（只读，**每个团默认折叠，防止剧透**）

- 收起状态只显示：群名、状态徽标、openid、模组名、回合数、调查员人数
- 展开后才显示：场景描述、角色数值、剧情进度、战役记忆、删除按钮
- 调查员：槽位、角色名、绑定玩家、HP/MP/SAN/幸运 进度条、移动/体格/伤害加值、
  状态标签、核心技能、持有物品
- 剧情进度：场景线索逐条列出，已解锁打 ✔，未解锁带「剧透」角标
- 战役记忆：`/note` 记下的条目，按重要性标星

模组清单另有公开端点 `GET /trpg/modules`（只含 id / 标题 / 幕数），
面板的下拉框走它，这样令牌不对时也不会是空的。

`/trpg/panel/config` 的自证规则：当前没配令牌 → 允许设置；
带了正确的当前令牌 → 允许；带的令牌等于要写入的新值 → 允许（本人主动重设）。

## 中文指令（0.15.0）

英文写法**全部保留**，中文只是别名，两种都能用。

| 中文 | 等价 |
|---|---|
| `/开始` `/开局` `/继续` | `/trpg start` |
| `/暂停` | `/trpg pause` |
| `/结束` `/结团` | `/trpg end` |
| `/重开` | `/trpg restart` |
| `/重置` | `/trpg reset` |
| `/模组 <id>` | `/trpg module <id>` |
| `/状态` `/团` | `/trpg status` |
| `/录卡 亚瑟 hp12 san65 侦查70` | `/st ...` |
| `/建卡` | `/st new` |
| `/角色卡` `/卡` | `/pc` |
| `/切换角色 P2` | `/pc use P2` |
| `/解绑` | `/pc release` |
| `/检定 侦查 [困难｜奖励1｜惩罚1]` | `/ra ...` |
| `/骰 3d6` | `/r 3d6` |
| `/理智 0/1d6` | `/sc ...` |
| `/幸运` | `/luck` |
| `/房规` | `/setcoc` |
| `/撤销` `/记录` `/战术` `/暂离` | `/undo` `/note` `/tactic` `/afk` |
| `/帮助` `/指令` | `/help` |

## 管理页的「指令」折叠块

设置下面还有一块「指令」，默认收起，列出全部命令（中文在前、英文在后，按 开局/角色卡/检定/其他 分组）。

- 条数显示在标题上（共 22 条）
- 这份表在 `impl.js` 的 `COMMAND_TABLE` 里，**改 `commands.js` 的 CN_ALIASES 时要同步**
- 表格只是展示，实际解析仍以 `commands.js` 为准

## 指令提示可配置

管理页「设置」里有「指令提示」编辑框：

- 填什么，群里 `/帮助` 就回什么
- 留空 = 用内置那套（`DEFAULT_HELP`，中英对照）
- 保存立即生效，下一句 `/帮助` 就能看到，不用重启

写入 `~/.dsh/dsh-trpg/config.json` 的 `helpText` 字段。

## 侧边栏入口（0.16.0）

插件加载后在 DSH 左上角侧边栏多一个**跑团面板**图标，点它就打开整页的跑团面板。

注册两个槽位，靠 id / key 对上：

| 槽位 | 注册 | 作用 |
|---|---|---|
| `sidebar.panellist` | `{ id: "dsh-trpg", order: 20, label: () => "跑团面板" }` | 侧边栏那行图标 |
| `main` | `{ key: "dsh-trpg" }` | 点开后中间区域整页渲染 |

图标组件只接收 `{ size }` —— 它**纯装饰**，点击和选中态由侧边栏自己处理
（它按 `id` 去 `main` 找同 key 的面板）。所以图标里不该写 onClick。

插件详情页里那块配置面板（`plugins.bundle.config`）保留，两处渲染同一个组件。

## 删除跑团记录

管理页每个团的标题行右侧有「删除」按钮：

- 二次确认，文案写明会连角色卡、回合快照、战役记忆一起删，且不可恢复
- 模组文件（`modules/*.json`）不受影响
- 端点 `POST /trpg/panel/delete`，需要共享令牌
- 返回删了多少：`{ investigators, snapshots, facts }`

**注意**：`trpg_scenes` 不删 —— 它存的是模组定义，多个群共用一份，删了会把别人的进度一起抹掉。

## 关于内联脚本（踩过的坑）

管理页的 `<script>` 是写在模板字符串里生成的。**模板字符串里的 `\n` 会变成真实换行**，
于是 `confirm('第一行\n\n第二行')` 落进 HTML 就成了跨行的单引号字符串 ——
整个 `<script>` 语法错误，页面上**所有**交互（保存 / 刷新 / 导入 / 删除）一起失效，
而控制台只有一行 SyntaxError，很难联想到是文案里的换行。

现在的写法：

```js
const NL = String.fromCharCode(10);
const tip = ['第一行', '', '第二行'].join(NL);
```

`test/admin-script.test.mjs` 会用 `new Function(script)` 真正解析这段内联脚本，
并检查有没有引号未闭合的行 —— 这类错误不会再溜过去。

## 0.16.2 修的几处（均为 bug 修复，无功能变更）

| 项 | 问题 | 修法 |
|---|---|---|
| F1 | outbound 是全局单例，两群并发跑团互相清 turn，骰子静默消失 | `Map<groupKey, outbound>`，每群一份 turn 与预算；超过 200 个实例时清最早的 |
| F2 | `readConfig` 不读 `moduleId`，设置页那个下拉是装饰品 | 两个名字都收，`moduleId` 优先 |
| F5 | `roostSendUrl` 只能改 bundle 配置 | `/trpg/panel/config` 接受该字段（校验 http/https），写进 config.json |
| F9 | `trpg_combat_tracker` 的 `enemies.items` 缺 `additionalProperties`，工具 5/6 | `deepFixSchema()` 递归补齐每个 object 节点 |
| F3 | `/trpg tools` 写在 `/trpg` 分支外，`act` 未定义 —— 不可达死代码 | 移进分支内，`/trpg tools` 现在真能用 |
| F4 | `/ra` 不传 houseRule，`/setcoc` 对本群检定无效 | 传 `session.houseRule`（缺省 `DEFAULT_HOUSE_RULE`） |
| F6 | `src/entry.js` 与 `src/host.js` 逐字节相同 | 删除 `entry.js` |
| F7 | 热重载只增不减 | `dispose` 里关 server / 停 batcher 与 turnRunner / 清 outbounds / 关 SQLite。ESM 缓存本身回收不了，但实例持有的资源能放掉 |

关于 F5 的一点实测记录：`17321` 端口上跑的是 **DeepSeek Harness 自己**（`Get-Process -Id 9888` → `DeepSeek Harness.exe`），
它的 `/api/plugins/...` 一律 404。Roost 的面板在 8080，`trpg-forwarder` 的路由挂在面板下，
所以默认值仍是 8080 —— 但现在端口可以改了。

## 0.16.4：令牌同步可观测化

改令牌时会顺带把新值推给 Roost 的 `trpg-forwarder` 并重载它 —— 否则转发器拿旧令牌投递，
群里没反应而日志只有 403，很难联想到是两边不一致。

| 以前 | 现在 |
|---|---|
| base 写死 `http://127.0.0.1:8080` | 从 `cfg.roostSendUrl` 推导 origin，端口改了跟着走 |
| 不带 `x-access-key` | 设了就带 |
| 「发出去就不管」 | 返回 `forwarder: { ok, base, step, status, message }` |

`step` 三档：`config`（写配置被拒）/ `reload`（重载失败）/ `network`（连不上）。
管理页和插件面板都按结果显示 —— 成功说打到哪，失败说清哪一步、地址是多少。

实测：

```
✔ 成功：PATCH + reload 都到达，带 x-access-key，base 正确
✔ Roost 401：step=config, status=401
✔ Roost 没在跑：step=network，但 DSH 侧仍保存成功、新令牌已生效
```

注意方向：**只能 DSH → Roost 推**。Roost 没有 `GET config` 路由，
从 Roost 面板改的令牌不会反向流回 DSH，那种情况两边都要填一遍。

（这一步只加同步可观测化，**不包含** Host / Origin 校验 —— 那个仍在 0.16.3 之前的状态。）

## 0.16.5：同步 404 的真实原因（桥没这个路由）

DSH 侧一直在调 `PATCH /api/plugins/trpg-forwarder/config`，
但 `trpg-forwarder` **只注册了 `POST /send`** —— 于是永远 404「接口不存在」。
这不是端口问题、也不是台账问题，是对方压根没有这个入口。

桥（0.6.3）补了两个路由：

| 路由 | 作用 | 鉴权 |
|---|---|---|
| `PATCH /config` | 写入 `token` | body 里的 `from` 必须等于当前令牌（首次配置时免） |
| `POST /reload` | 空操作，回 ok | 无 |

`/reload` 只是为了让 DSH 那条调用链完整 —— 转发器的配置是每次 `conf()` 现读的，本来就不需要重载。

DSH 侧同步时会带 `from: <旧令牌>` 自证：

```js
fetch(base + '/api/plugins/trpg-forwarder/config', {
  method: 'PATCH',
  body: JSON.stringify({ token: 新值, from: 旧值 }),
})
```

这样任意本地进程没法随便改转发器的令牌，而 DSH 手里正好有旧值。

### 「一改令牌就连不上」

服务端行为实测是对的：改完新令牌可读、旧令牌立刻 403、config.json 已更新。
真正让群里断掉的是**两边不一致** —— DSH 侧改成功了，Roost 侧因为 404 没改，
转发器拿着旧令牌投递，群里自然没反应。同步路由补上之后这个问题就没有了。

## 0.16.6：真正的 404 根因 —— 少了 `/r`

Roost 的插件路由地址是 **`/api/plugins/<id>/r<路径>`**，那个 `r` 是框架的固定前缀：

```js
ctx.registerRoute('PATCH', '/config', handler)
// → 实际挂在 /api/plugins/trpg-forwarder/r/config
```

DSH 侧写的是 `/api/plugins/trpg-forwarder/config`（少了 r），所以永远 404 `{"error":"接口不存在"}`。
`/send` 之所以一直正常，是因为 `roostSendUrl` 里本来就有 `/r/`。

实测对比（Roost 在跑时）：

```
PATCH /api/plugins/trpg-forwarder/r/config   → 403（路由存在，from 不对）
PATCH /api/plugins/trpg-forwarder/config     → 404（路径根本不存在）
```

修完之后带真实令牌打通：

```
PATCH /r/config  {"token":"<当前>","from":"<当前>"}  → 200 {"ok":true,"tokenConfigured":true}
POST  /r/reload                                        → 200 {"ok":true,"reloaded":false}
```

`test/sync-path.test.mjs` 用假 Roost 锁死这条路径：少一个 `/r` 测试就会红。

## 0.16.7：反向同步（Roost 改 → DSH 跟上）

之前只做了「DSH 改 → 推给 Roost」。反方向一直缺，而这正是「Roost 侧对了、DSH 侧还是不行」的原因：
用户在 Roost 面板改了令牌，DSH 不知道，于是转发器用新令牌投递、DSH 用旧令牌校验 —— 一律 403，
群里彻底没反应，而两边各自看配置都正常。

新增 `GET /api/plugins/trpg-forwarder/r/token`（桥 0.6.4），DSH 三个时机去拉：

| 时机 | 说明 |
|---|---|
| 启动后 1.2 秒 | 先跟 Roost 对齐一次 |
| 每次鉴权前 | fire-and-forget，10 秒缓存 |
| **每次 `/trpg/event` 到达时** | `await` 一次再校验，这是群里发消息那条路径 |

不一致就以 **Roost 为准**更新本地 `cfg.token` 并写回 config.json ——
它是「群里实际在用的那个」，DSH 必须跟上，否则所有事件都会被自己的鉴权挡在门外。

`handleRequest` 因此改成 `async`，`createServer` 回调里接住 promise 的 reject ——
宿主把 `uncaughtException` 当 fatal，一个未处理的 rejection 就能让插件宿主退出。

## 0.16.8：单聊（c2c）支持

桥的中间件原来只认 `group`：

```js
if (!c.enabled || !msg || msg.kind !== 'group' || isBotMessage(msg)) return next();
//                                 ↑ 私聊消息在这里被放行给 ai-chat
```

于是私聊里发 `/开始` 一条都到不了 dsh-trpg，被当成普通聊天回了 —— 就是「私聊指令无效」。

现在 `group` 和 `c2c` 都接：

| 项 | 群聊 | 单聊 |
|---|---|---|
| 会话键 `groupId` | 群 openid | **对方 openid** |
| 事件字段 | `direct: false` | `direct: true` |
| 回复通道 | `api.sendGroup` | **`api.sendC2C`** |

`sendC2C` 这点必须分开：拿 `sendGroup` 发单聊 openid 会 400「群不存在」，
而那个错误在群里看不到，只体现在日志里。

### 关于「中文指令无法生效」

日志里已经能看到 `已投递 …（/trpg 开始）` 和对应回复，说明桥的中文白名单（0.6.2）是生效的。
如果你试的是不带前缀的 `/开始`，那是另一个原因 —— 见下一节。

## 令牌拉取的两个档位（0.16.8 调整）

| 时机 | 行为 |
|---|---|
| 启动 / 保存后 | **只提示不一致，不覆盖** |
| 每次 `/trpg/event` 到达 | **覆盖**（以 Roost 为准） |

启动就覆盖会有副作用：「DSH 刚改成新值、推送失败」时，重启会被 Roost 的旧值悄悄盖回去，
用户看到「改了又变回去了」。而事件路径不一样 —— 那条请求本身就是 Roost 用它的令牌发来的，
它能发出来就说明那个值才是活的。
