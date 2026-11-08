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
