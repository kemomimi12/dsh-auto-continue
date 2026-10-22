# dsh-auto-continue

会话因为**一次模型请求失败**而结束轮次后，自动排队一条续行提示词接着做。

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的 Cordis 插件。**手动停止永远优先**，永久错误不重试，同一次网关故障只买一次续行。

## 它解决什么

dsh 的 agent loop 把「一次模型请求失败」当作整个轮次的终点：

```js
// dsh-agent-loop: step() 内
if (finish.kind === 'error' || finish.kind === 'aborted') {
  const action = await this.dispatch.waterfall('agent/request-error', {...});
  if (action?.kind !== 'retry') throw new LlmError(...);   // → turn/end { kind: 'error' }
}
```

`@deepseek-ai/dsh-llm-retry` 只负责**轮次内同一步**的重试，而且只重试提供方策略里列出的失败码。当网关把长 SSE 掐断（`MALFORMED_RESPONSE` / `STREAM_CLOSED`），或重试预算耗尽时，轮次直接死掉，会话停在 idle 等你手动打字。

本插件在**轮次边界**补上这一层。

## 与内置重试的分工

| 层 | 谁负责 | 边界 |
|---|---|---|
| 同一步内重试 | `dsh-llm-retry` + 适配器的 `retryPolicy` | `agent/request-error` |
| 跨轮次续行 | 本插件 | `session/event` 的 `turn/end` |

两层互补：先让内置重试把能救的救回来（便宜、无副作用），救不回来再由本插件续行（会多花一次上下文）。

**建议同时配置 `retryPolicy`**，否则 `MALFORMED_RESPONSE` / `STREAM_CLOSED` 这类错误根本不会进入重试，会直接落到本插件这一层，白白多花一次完整上下文。见下方[配套配置](#配套配置retrypolicy)。

## 安装

### 方式一：`plugin_manager`（推荐）

**先 clone 下来**（本包未发布到 npm，所以只能用本地路径）：

```bash
git clone https://github.com/kemomimi12/dsh-auto-continue.git D:/plugins/dsh-auto-continue
```

然后让 dsh 里的模型调用 `plugin_manager` 工具：

```
install_bundle  target: D:/plugins/dsh-auto-continue
```

`install_bundle` 会自己处理 pnpm 安装、写 profile 的 `package.json` 与 bundle 列表，**不要手工编辑**。

### 方式二：手工写 profile

如果不想用 `plugin_manager`，编辑你的 profile（`$DSH_HOME/profiles/<name>/`）：

1. `package.json` 的 `dependencies` 加一行：

   ```json
   "dsh-auto-continue": "link:D:/plugins/dsh-auto-continue"
   ```

2. 同一个 `package.json` 的 `dsh.profile.bundles` 追加：

   ```json
   "dsh-auto-continue"
   ```

3. 在 profile 目录跑一次 `pnpm install`。

### 验证安装

插件行出现在 profile 里且状态为 `active` 即成功。可用 `plugin_manager` 的 `list_plugins` 查看，或直接查：

```
include:auto-continue    enabled: true    fiberPhase: active
```

## 配套配置：retryPolicy

本插件只处理**跨轮次**的恢复。让内置重试先接住可重试的协议错误，才能少花上下文。在 `cordis.patch.yml` 里给提供方适配器加上：

```yaml
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    # ... 你原有的 baseURL / models / apiKeyEnv ...
    retryPolicy:
      mode: normal
      maxRetries: 5
      retryableCodes:
        - EMPTY_RESPONSE
        - RATE_LIMIT
        - SERVER
        - TIMEOUT
        - TRANSPORT
        - MALFORMED_RESPONSE   # tool 参数 JSON 被截断
        - STREAM_CLOSED        # 流在 message_stop 之前结束
      backoff:
        initialDelayMs: 1000
        maxDelayMs: 120000     # 必须 ≥ 网关的 Retry-After，否则会放弃重试
        jitterRatio: 0.2
```

> `maxDelayMs` 小于提供方返回的 `Retry-After` 时，`normal` 模式会**直接放弃重试**。若你的网关会返回 `Retry-After: 120000`，这里就得是 `120000`。
>
> `maxRetries: 5` 是个折中：最坏退避约 31 秒；8 次则会让最后一次撞上 120 秒上限。

## 安全边界

- **手动停止永远优先。** 续行消息是立刻排进 inbox 的，不是藏在不可见的定时器里。你按停止 → `cancel()` 清空 inbox → 插件观察到消息消失并停手。
- **人类输入优先。** 你一旦发出消息，插件会把自己还排在队里的续行提示撤掉。
- **永久错误不重试。** `AUTH` / `QUOTA` / `INVALID_REQUEST` / `CONTEXT_WINDOW_EXCEEDED` 等直接放弃。
- **有预算上限。** 每个会话有滚动窗口内的次数上限 + 连续失败上限，防止坏路由把余额烧穿。
- **故障风暴合并。** 同一错误码在时间窗内反复出现视为**一次**故障，只买一次续行（见下）。
- **不抢 goal 的活。** 会话已有 armed 的 goal 时不介入，避免和 `dsh-goal-round-driver` 打架。
- **卸载即停。** 插件 dispose 时取消所有待发续行。

## 故障风暴合并

网关整分钟不可用时，每个轮次都会以**同一个错误码**失败。若不合并，每次失败都像一个独立事件，各自买一次续行——2026-10-21 那次真实事故就是这样烧掉了 5 次。

风暴的判定：

- 相同 `code`，且距上次同码失败 < `stormWindowMs` → 视为**同一场风暴**
- 不同 code，或间隔超过 `stormWindowMs` → **新风暴**，重新计数
- 轮次正常结束、人工介入、或遇到永久错误 → 风暴关闭

一场风暴最多买 `maxResumesPerStorm` 次续行（默认 1）。

真实事故回放（5 个连续 SERVER 失败）：

```
不合并：turn 7..11 各续一次 → 5 次
合并后：turn 7 续一次，turn 8..11 停手 → 1 次
```

## 配置

写在 `cordis.patch.yml`（或直接改 profile 里 `auto-continue` 那一行）：

```yaml
- id: auto-continue
  name: 'dsh-auto-continue'
  config:
    enabled: true
    maxResumesPerWindow: 5        # 滚动窗口内最多自动续行几次
    windowMs: 3600000             # 窗口长度（1 小时）
    maxConsecutiveFailures: 3     # 连续失败几次后彻底停手
    includeSubagents: true        # 是否也管子代理会话
    stormWindowMs: 120000         # 同码失败间隔小于它就算同一场风暴
    maxResumesPerStorm: 1         # 一场风暴最多买几次续行
```

> 这一行是可选的。不写就用代码里的默认值（与上表一致）。
>
> 注意：本插件**没有声明 `Config` schema**（原因见[实现约束](#实现约束)），所以 `plugin_manager` 的 `Config.listConfigs` 会显示 `status: absent`，这是预期行为，不影响插件工作。

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `maxResumesPerWindow` | `5` | 窗口内最多续行次数 |
| `windowMs` | `3600000` | 滚动窗口长度 |
| `maxConsecutiveFailures` | `3` | 连续失败（期间无正常结束轮次）上限 |
| `includeSubagents` | `true` | 是否处理 `origin: 'subagent'` 的会话 |
| `stormWindowMs` | `120000` | 同码失败合并为同一风暴的时间窗 |
| `maxResumesPerStorm` | `1` | 单场风暴的续行上限 |

## 四道闸门

一次失败要依次穿过，全部通过才续行：

1. **永久错误** → 直接放弃
2. **连续失败上限** `maxConsecutiveFailures`
3. **滚动预算** `maxResumesPerWindow`
4. **风暴预算** `maxResumesPerStorm`

实际续行次数取这几者的**最小值**。

## 续行提示词长什么样

进入历史的是普通 user 角色消息，`source.kind === 'auto-continue'`：

```text
<auto_continue>
The previous turn ended because a model request failed: TRANSPORT: DeepSeek Messages transport failed
This is automatic resume attempt 2. The session state above is authoritative.
Re-check the current workspace and tool results instead of assuming earlier narration is still current, then continue the task from where it stopped.
Do not repeat tool calls whose results are already in the transcript.
</auto_continue>
```

提示词刻意让模型**重新核对工作区**而不是相信之前的叙述——这正好对上「网关断流后可能有半截工具调用」的场景。

## 实现约束

本模块只 import `node:crypto`，**不 import 任何包**。原因：bundle 以 `link:` 方式安装后，ESM 从**真实路径**解析裸说明符（realpath 之后在 profile 之外），`@deepseek-ai/*` 会解析失败。所以续行消息在本地构造，config 也在本地校验，不依赖 `@deepseek-ai/schemastery`。

代价是**没有 `Config` schema**：`plugin_manager` 的配置页看不到字段，改配置直接编辑 `cordis.patch.yml`。

## 测试

```bash
npm test             # 28 项行为测试（含 7 项启动自检用例）
npm run test:storm   # 风暴合并效果演示
npm run test:replay  # 真实故障序列回放
```

| 文件 | 作用 |
|---|---|
| `test.mjs` | 28 项行为测试，用假 host 驱动真实插件逻辑 |
| `storm.mjs` | 对比有/无风暴合并：同一次故障从 5 次续行降到 1 次 |
| `replay.mjs` | 用 2026-10-21 真实会话事件序列回放决策 |

`test.mjs` 覆盖：临时失败续行、永久错误不续行、用户中止不续行、人类输入撤回续行、连续失败上限、**模型输出不算进展**、正常结束才算进展、失败续行不重复购买、滚动预算、单风暴只买一次、不同码各自成风暴、超窗口算新风暴、子代理开关、busy 时不打扰、卸载后不再触发。

> 这些测试不依赖 dsh 运行时，只依赖 Node ≥ 22。

## 已知限制

- **只在轮次边界工作。** 它不能修复一次失败的请求本身，只能在该轮次结束后重开一轮。
- **续行会多花一次完整上下文。** 这是它排在 `retryPolicy` 之后的原因。
- **没有持久化状态。** 插件状态在内存里，dsh 重启后预算与风暴记录归零。
- **未在多个 dsh 版本上验证。** 依赖的公开接口见下方[启动自检](#启动自检)；自检能挡住接口缺失，但挡不住**语义变化**（例如 `followup` 还在、但行为改了）。
- **子代理会话默认也管。** 若子代理失败后你想让它直接结束，把 `includeSubagents` 设为 `false`。

## 兼容性

| 项 | 要求 |
|---|---|
| Node | ≥ 22（用了 `randomUUID`、`setImmediate`） |
| dsh | 提供 `agents` / `sessions` 服务与 `session/event` 事件（当前 desktop 版本满足） |
| 权限 | 无特殊要求，纯 Host 插件，不碰文件系统 |

### 启动自检

插件激活时会**结构性地检查**它依赖的每个接口是否存在，不依赖版本号字符串。任一缺失就**记录一条 error 日志并禁用自己**，而不是装上去然后静默不工作。

检查项：

| 接口 | 用途 |
|---|---|
| `agents.get(id)` | 按 session 找到 live Agent |
| `agents.list()` | 激活时枚举已有 Agent |
| `ctx.on()` / `ctx.effect()` | 注册并持有事件监听 |
| `Agent.followup(message)` | 排入续行提示词 |
| `Agent.inbox.nextTurn` / `nextStep` | 续行前检查是否已有排队输入 |
| `Agent.inbox.remove(id)` | 人工接管时撤回续行 |
| `Agent.status` | 避免打扰正在运行的 agent |
| `Agent.session` | 把会话事件对应到 agent |

不兼容时的日志长这样：

```
auto-continue: disabling itself — this DeepSeek Harness does not expose 1 required interface(s):
  - Agent.followup(message): needed to queue the resume prompt
Upgrade Harness, or remove the auto-continue bundle from the profile. Nothing will be resumed while disabled.
```

兼容时记一条确认：

```
auto-continue: host interfaces verified, resuming enabled
```

> 这条 `info` 日志是排查时的第一个检查点：**看不到它，就说明插件没跑起来**。

## License

[MIT](./LICENSE)
