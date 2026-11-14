# dsh-model-failover

面向 DSH 0.2.2-rc.3 的会话级模型故障转移插件。内置重试链放弃后，若错误符合触发条件，插件把当前智能体切到故障转移链的下一档，并排入一个新的重试轮次让会话继续。它只改当前会话的模型选择，不改全局默认模型。

**新版以「设置页」为主操作界面**：在设置页勾选、排序所有已连接 provider 的模型，组成唯一一条有序故障转移链；保存即时生效，无需手写 YAML。纯 YAML 工作流仍保留，但不再是主路径。

> 未核实的界面文案、按钮名称与分组标题以设置页实际显示为准。

## Overview / 工作原理与运行时限制

- 默认链：`workbuddy/hy4free` → `workbuddy/hy3` → `workbuddy/hy4std`（保守默认，同一 provider）。
- 触发码见下节。插件在 `agent/request-error` 瀑布链中先 `next()`；只有整条链放弃且失败符合条件时，才在智能体空闲后选下一档，并以空的 `retry` 消息排入新轮次。绝不吞掉失败，也不在瀑布内切模型。
- **已核验的运行时限制：切换只对下一步 / 新的一轮生效，不会重发当前这一步的同一请求。** 循环在每步开始时冻结 `decision.selection`（`dsh-agent-loop/src/agent.ts:451`），步内重试复用它（`dsh-agent-loop/src/agent.ts:641-645`）；`agent.model.select()` 写入持久化会话级选择，供后续轮次读取。
- **`QUOTA` 被 DSH 内置「继续 / Continue」按钮排除**（`dsh-api-session-controller/src/continuation.ts:9-11`），因此本插件自行用 `source: { kind: 'retry' }`、空 `content` 的消息调用 `agent.followup()` 驱动续跑。
- **WorkBuddy 会在内部轮换账号**：额度错误穿透到 DSH 时，其账号池已耗尽；插件不管理、补充或重置 WorkBuddy 账号，只按链尝试下一条路由。
- 人工输入优先：若期间出现非 `retry` 来源的用户消息，自动续跑意图被丢弃；每个智能体的驱动串行执行，同一失败步骤只记录一次意图。

## Settings Page / 设置页

设置页在 **Settings（设置）→ 插件分区「模型故障转移」**（section id `dsh-model-failover`）中，入口标题与位置以设置页实际显示为准。客户端 `lib/client.js` 通过 `ctx.slots.inject("settings.section")` + `ctx.slots.register` 注册自定义卡片；服务端 Config 是真实 Schemastery schema（各字段带 `.volatile()`），并用 `settings.configure({ auto: false }, ctx.fiber)` 关闭自动表单，由卡片自行渲染和保存。

### Where to find all providers & models / 查看全部已连接模型

页面通过 `ctx.remote.session.modelCatalog()` 拉取目录，返回按 provider 分组的 `groups[{ id, name, models[{ id, name, reasoning }] }]`，列出**所有已连接的 provider 及其模型**，而不是只列当前链。目录区按 `provider` 分组，每行显示模型名称、模型 id 与是否已入链；卡片读取的是 `groups[].id / name / models[].id / name`，其余字段（如 `reasoning`）的展示以设置页实际显示为准。目录来自当前 session 已注册的连接插件，动态变化，具体条目以设置页实际显示为准。

### 界面交互（v0.2.0）

- 卡片分区：运行策略 / 降级链 / 全部已接入模型 / 触发错误码 / 切换留痕与恢复，顶部状态徽标显示启用状态、可用模型数与链内档数。
- 降级链支持 **拖拽排序** 与 ↑↓ 按钮；链内标注「主模型 / 第 N 档」，一键清空链或恢复默认参数。
- 模型目录支持**搜索**（名称 / ID / provider）、**折叠分组**、**全选当前搜索结果**；已入链模型高亮。
- 触发码改为可点击的胶囊开关；可全选 / 全不选。
- **脏状态**：有未保存改动时显示「● 未保存」与「保存更改」，底部粘性保存条出现「放弃更改」，离开页面前提示；无改动时保存按钮禁用并显示「已保存」。
- 数字输入框聚焦即全选，便于直接替换数值；切换留痕展示最近 10 条；错误/加载状态带重试入口。

### Check & reorder / 勾选与排序

- 勾选一个模型即把它加入**唯一一条有序故障转移链**（`priority`）；取消勾选即从链中移除。
- 用链内每行的 ↑ / ↓ 按钮调整顺序（另可用「移除」按钮取消入链），顺序就是降级顺序。
- **未勾选的模型永远不会被本插件使用**：它们只出现在目录列表里，不进入 `priority`，也不会被 `agent.model.select` 选中。
- 链的每一项形如 `{ provider, model, reasoningEffort? }`；`reasoningEffort` 可选，随切换一并传给 `agent.model.select`。
- 默认链为同 provider 的三项。页面允许跨 provider 混选，但当链中出现多个 provider 时会显示**跨 provider 警告**：切换时会丢弃其它供应商的历史 thinking 块、KV 缓存复用下降，凭据/计费也可能不同；保守起见建议同一 provider 内排序，跨 provider 仅作为兜底。

### How saving works / 保存如何生效

1. 页面把勾选结果、顺序、触发码白名单、开关、上限等变更通过插件自有的 loopback POST 路由提交。
2. 服务端调用 `settings.mutate(ns, [{ op: 'set', path, value }], revision)`（当前实现第三个参数传 `undefined`，由 Host 按最新配置处理），它经 `configEditor.edit` 把值写入 `<profile>/cordis.patch.yml` 的 id-targeted `config:` 覆盖条目。
3. Cordis **HMR 立即重组合**，插件以新 Config 重新生效，无需重启 Host、无需手改 YAML。
4. 切换目标在被选中前会尽量用 `ctx.llm.resolveCallConfig({ provider, model })` 校验（可用时）；无效项不会作为目标。
5. 历史记录写入 `switchLog` 也走同一条保存路径；写失败只记 warn，不影响切换。

### What the card also manages / 卡片还管理什么

设置卡同时管理：触发码白名单、总开关 `enabled`、每会话切换上限 `maxSwitchesPerSession` 与冷却 `cooldownMs`、切换历史 `switchLog` 以及「手动恢复」按钮。各字段语义见下节。

## Configuration / 全部配置字段

字段名、类型与默认值与冻结的 Config schema（`lib/index.js:32-46`）一致；`rules.yaml` 与 `config.example.yml` 是同结构的纯 YAML 模板。

| 字段 | 类型 | 默认值 | 语义 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关。`false` 时不做任何切换，已有会话模型选择不回滚。 |
| `priority` | array of `{ provider, model, reasoningEffort? }` | `workbuddy/hy4free`、`workbuddy/hy3`、`workbuddy/hy4std` | 唯一有序故障转移链，即设置页勾选并排序的结果。失败时取当前模型的下一项；当前模型不在链中则从第一项开始；空数组或全部条目非法时回退默认链；重复项按 `provider/model/reasoningEffort` 去重，非法项丢弃。未勾选的模型不在此数组中，永不使用。 |
| `triggers` | array of string | `QUOTA`、`ACCOUNT_QUOTA`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`STREAM_CLOSED` | 触发码白名单（**7 个默认码**）。此外 `HTTP_5xx`（即 `HTTP_500`–`HTTP_599` 形式）或数值 `status >= 500` 也可判定为可降级；`UNKNOWN` / 空码且消息含额度耗尽措辞时也可触发。空数组回退默认 7 码；非大写字母/数字/下划线条目丢弃、重复码去重。该列表是权威配置，内置码不绕过它。 |
| `maxSwitchesPerSession` | number (min 0) | `3` | 每个智能体在一次连续运行中的自动切换次数上限。达到上限即停止切换并丢弃本次意图；`0` 表示完全禁止自动切换。智能体回到 idle 且无待处理意图时计数归零；手动恢复也会清零。 |
| `cooldownMs` | number (min 0) | `0` | 两次自动切换之间的最小间隔（毫秒）。`0` 为不冷却；冷却窗口内的失败不切换、意图被丢弃。 |
| `switchLogLimit` | number (min 1) | `20` | `switchLog` 的保留条数上限，超出时只保留最新 `switchLogLimit` 条。 |
| `switchLog` | bounded array | `[]` | 切换历史。每条为 `{ at, code, from, to, reason }`：时间戳、错误码、源 `provider/model`、目标 `provider/model`、原因（自动为 `auto`）。有界，不会无限增长。 |

**7 个默认触发码：** `QUOTA`、`ACCOUNT_QUOTA`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`STREAM_CLOSED`。另可添加 `HTTP_500`–`HTTP_599` 形式的自定义码，或依赖数值 `status >= 500`；其它大写自定义码也可写入 `triggers` 扩展白名单。

`AUTH`、`INVALID_REQUEST`、`CONTEXT_WINDOW_EXCEEDED`、`EMPTY_RESPONSE`、`MALFORMED_RESPONSE`、`IMAGE_OFFLOAD_REQUIRED`、`ABORTED`、`CANCELLED` 明确不触发；4xx 等非 5xx 状态也不触发。

设置页的触发码白名单以可勾选项呈现，具体可勾选项以设置页实际显示为准；数值 `status >= 500` 只在错误码为通用码（空、`UNKNOWN` 或 `HTTP_xxx` 形式）时参与判定，明确的终端错误码优先。若页面上出现 `EMPTY_RESPONSE` / `MALFORMED_RESPONSE` / `CONTEXT_WINDOW_EXCEEDED` 等可勾选项，它们仍被上述排除列表拦下，不会触发。

优先级项也兼容 `provider/model` 字符串，但推荐统一使用对象形式：

```yaml
priority:
  - provider: workbuddy
    model: hy4free
  - provider: workbuddy
    model: hy3
  - provider: workbuddy
    model: hy4std
    reasoningEffort: low
```

provider 必须已由相应连接插件在 DSH 注册、模型在其目录中可用；跨 provider 混用前请阅读上节的警告。模型目录会变化，以设置页实际显示为准。只改 `priority` 不改全局默认模型（插件从不调用 `ctx.agentDefaultModel.saveSelection`）。

## History & Restore / 切换历史与手动恢复

- 每次成功切换追加一条 `switchLog` 记录，并通过 `settings.mutate` 持久化到 `cordis.patch.yml`；日志受 `switchLogLimit` 约束。
- 设置卡展示切换历史（最新在上），并提供**手动恢复**按钮：调用插件的 restore 动作，把当前活动列表中的第一个智能体选回 `priority` 的**第一项**，并把该智能体的 `switches` 计数清零；不会清空 `switchLog`，不回滚全局默认模型。无活动智能体时返回 `no active agent`。按钮文案、作用目标与历史展示形式以设置页实际显示为准。
- 不手动恢复时，切换后的模型一直保持到下次切换或用户自行在模型选择器里更改；插件不会自动回滚。
- **链耗尽（chain exhaustion）**：当前模型已是 `priority` 最后一项、或找不到下一档时，不再 `select`、不再 `followup`，只记 `priority list exhausted` 告警并停止，等待人工处理。
- **每会话上限 / 冷却**：`canSwitch` 在 `switches >= maxSwitchesPerSession` 或距上次切换不足 `cooldownMs` 时拒绝本次切换，丢弃意图并记 `switch budget/cooldown held` 日志；之后的新失败步骤可重新尝试。
- 日志与通知：`ctx.logger.info` 记 `dsh-model-failover: recorded intent ...` 与切换摘要 `[failover] <code>: <from> -> <to>; continuing`（最长 120 字符）；失败、耗尽、冷却分别有 warn/info 行。DSH 自身在下一个 `agent/pre-step` 写入会话可见的 `[model changed: ...]` 通知（`dsh-agent/src/model-selection.ts:157-173`），插件不重复追加事件。

## Migration / 从已安装的 v0.1.0 升级到 v0.2.0（设置页版）

已在 `<profile>` 作为 `file:` bundle 安装、并带 `cordis.patch.yml` 中 id 为 `dsh-model-failover` 的 `config` 覆盖条目的 v0.1.0，升级时：

1. **现有 3-model 链保留为默认**：`workbuddy/hy4free` → `workbuddy/hy3` → `workbuddy/hy4std` 继续作为 `priority` 的默认值，行为不中断。
2. **其它已连接模型默认未勾选**：目录里会列出全部 provider/model，但只有原链中的三项进入 `priority`，其余均不勾选、**永不使用**，需要时再手动勾选并排序。
3. **不需要手改 YAML**：设置页保存会自己更新 `cordis.patch.yml` 并触发 HMR；旧的手写 `config` 覆盖条目可被设置页接管，无需手工迁移字段。
4. **旧纯 YAML 工作流仍可用但不再是主路径**：`rules.yaml` / `config.example.yml` 继续作为离线模板，可把值同步进 `<profile>/cordis.patch.yml` 的 `config:` 覆盖条目；字段与设置页完全一致。纯 YAML 方式不经过 HMR，改完后**需完整重启 Host** 才能确认所有智能体使用同一份规则。
5. 新增字段（`maxSwitchesPerSession`、`cooldownMs`、`switchLog`、`switchLogLimit`）未显式配置时走上表默认值；旧配置里没有它们也不会报错。

更短的说明见 `docs/MIGRATION.md`。

## Install & Enable / 全新 profile 安装

示例中的 `<profile>` 指目标 profile 目录（例如 `<profile>`）。安装这个包**不会自动修改正在使用的 profile**，以下步骤需手动完成。

1. **`file:` bundle**：把 `dsh-model-failover` 加入 `<profile>/package.json` 的 `dependencies`，指向本地目录（例如 `"dsh-model-failover": "file:D:/Agent/DSH"`），并在 `<profile>` 目录用 DSH 自带的 Node/pnpm 执行 `pnpm install --no-frozen-lockfile`；同时把 `dsh-model-failover` 加入 `dsh.profile.bundles` 列表。也可用 DSH 插件管理器把包放进 profile，但仍需第 2 步。
2. **cordis patch insert**：在 `<profile>/cordis.patch.yml` 这个顶层 YAML 补丁数组中追加一条 insert 记录，保留已有条目（形状见包内 `cordis.patch.yml:3-5`）：

```yaml
- insert:
    - id: dsh-model-failover
      name: dsh-model-failover
```

   若还要预设配置，另把 `config.example.yml` 的整条 id-targeted `config` 覆盖条目追加到**同一补丁数组**（不要塞进 `- insert:` 列表）。profile 的 `cordis.yml` 是空的组合根，不要改它。
3. **完整重启 Host / DSH**：新包、`dsh.client` 入口、bundle 与 Cordis 组合只在启动时加载。
4. 打开 **Settings → 插件分区 `dsh-model-failover`**，勾选模型、排序、设触发码与上限并保存。之后所有配置改动都走 HMR，无需再重启。

## Update / 更新现有 live install

对已安装的 `file:D:/Agent/DSH` 这类本地目录安装：

1. **同步文件**：把新版本文件（含 `lib/client.js`、`lib/index.js`、`package.json` 中新增的 `exports['./client']` 与 `dsh.client` 声明）放到 `file:` 指向的目录；`file:` 安装通常直接指向源目录，写入即完成同步。若用的是 tarball / 复制式 `file:` 包，需重新安装或替换包内容，并用 `pnpm install --no-frozen-lockfile` 刷新。
2. **首次新增客户端入口需完整重启 Host**：`dsh.client` 与 bundle 清单在启动时读取；重启后设置页 section 才会注册。
3. **HMR recomposition**：Cordis 会在模块 / 配置变化时重组合，运行期通过 `settings.mutate` 的保存即时生效。`<profile>/cordis.patch.yml` 中已存在的 `config:` 覆盖条目保持不变，由设置页接管；其余插件条目不要改动。
4. 验证：设置页能列出全部已连接模型、能勾选排序、保存后 `cordis.patch.yml` 的 `config` 被更新、切换历史与恢复按钮可见。具体以设置页实际显示为准。

## Troubleshooting / 排障

- **设置卡缺失（card missing）**：确认 `package.json` 含 `exports['./client']` 与 `dsh.client: { platform: 'web', inject: [...] }`、`lib/client.js` 存在且被同步；确认 `dsh.client` 的 `inject` 列表与 Host 提供的服务匹配；确认 `ctx.slots.inject` / `ctx.slots.register` 可用（缺失时卡片会跳过注册并在 console 留 warn）、Config 是真实 Schemastery schema 且**每个可编辑字段都带 `.volatile()`**、`settings.configure({ auto: false }, ctx.fiber)` 已执行；确认 `<profile>/cordis.patch.yml` 中 insert 的 **entry id** 为 `dsh-model-failover` 且与设置描述里的 `ns` 一致；新增客户端入口后**完整重启 Host**。
- **模型目录为空（catalog empty）**：`session.modelCatalog()` 只返回已连接的 provider。先确认对应连接插件已在该 profile 注册并启用、provider 已完成连接/认证、`ctx.llm.listProviders()` 能看到它；必要时重启 Host 让新连接生效。卡片会显示「模型目录读取失败：session.modelCatalog 不可用」或「modelCatalog refused」，可用「重新读取」按钮重试。具体以设置页实际显示为准。
- **保存被拒绝（save refused）**：`settings.mutate` 经 `configEditor.edit` 只写 profile 的 `cordis.patch.yml`；若 patch 由 home 目录层或 `argv` 启动参数层提供且优先级更高，编辑会被拒绝或写入不生效——检查 patch 来源与写权限，改用设置页所编辑的那一份 patch。若 Host 报**过期 revision**（stale revision，多端/多标签同时编辑时可能出现）：点「重新读取」或重开设置页后再保存。另检查 `settings.describe()` 中是否存在 `dsh-model-failover` 的 `ns` 条目，以及 loopback POST 是否被允许（仅 `127.0.0.1` / `::1`）。
- **没有发生切换（no switching）**：逐项排查 `enabled` 是否为 `false`；是否已达 `maxSwitchesPerSession` 或仍在 `cooldownMs` 冷却窗口（日志 `switch budget/cooldown held`）；失败码是否不在 `triggers` 且非 `HTTP_5xx` / `status >= 500`；当前模型是否**不在 `priority` 链中**（会从链首开始，而不是继续向后，且链首可能就是当前模型）；是否已到链末（`priority list exhausted`）；`<profile>/cordis.patch.yml` 的 `config` 是否真的被 HMR 重组合；内置 `dsh-llm-retry` 返回的 `{ kind: 'retry' }` 会被原样透传，那不是本插件的触发点；用户新消息是否抢先取消自动续跑；查看 `dsh-model-failover:` 前缀日志。
- **跨 provider 切换后异常（thinking block / KV cache）**：不同 provider 的 thinking block 格式与 KV cache 不互通，跨 provider 切换可能丢缓存或出现思考块格式不兼容，属已知限制；优先用同一 provider 内的链，跨 provider 仅作兜底，必要时手动恢复到链首。
- **切换看起来「没生效」**：切换只对**下一步 / 新的一轮**生效（`dsh-agent-loop/src/agent.ts:451`、`:641-645`），当前失败步骤会正常结束；`QUOTA` 也不在内置 Continue 里（`dsh-api-session-controller/src/continuation.ts:9-11`），续跑由插件排入。
- **反复切换 / 像循环**：每个新失败步骤只向后降一级，档位有限；链末会停止。若列表含重复等价项或切换后当前模型不在列表中（会从链首重新开始），请去重并保持单向顺序；必要时把 `enabled` 设为 `false`、降低 `maxSwitchesPerSession` 或增大 `cooldownMs`。
- **停用 / 卸载**：设置页把 `enabled` 设为 `false` 即可即时停用；彻底卸载则从 `<profile>/cordis.patch.yml` 删除该 insert 与 `config` 条目、从 `dependencies` / `bundles` 移除包，再完整重启 Host。已写入会话的模型选择不会被插件回滚，请手动改回。
