# 插件市场收录申请

目标仓库：[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

收录后会自动出现在 dsh 的「插件市场 → 发现」里。

---

## 提交方式

收录不是提交到 dsh-market，而是向 **awesome-dsh-plugin** 提 PR，**只加一个文件**：

```
data/plugins/kemomimi12__dsh-auto-continue.yml
```

内容（已备好，见 `.github/market-entry.yml`）：

```yaml
url: https://github.com/kemomimi12/dsh-auto-continue
name: kemomimi12/dsh-auto-continue
category: dev
description:
  en: 'Resumes a session at the turn boundary after a transient model-request failure ends it, with permanent failures skipped, one resume per provider outage, and a manual stop always winning.'
  zh: '模型请求临时失败导致轮次中断后自动续行；跳过永久性错误，同一次网关故障只续一次，手动停止永远优先。'
```

> `en` 描述含 `: ` 时必须加引号，否则 YAML 解析失败。已加。

---

## 提交前必须完成的清单

| 项 | 状态 | 说明 |
|---|---|---|
| `package.json` 声明 `dsh.bundle` | ✅ | 已有 |
| 仓库根有 `cordis.patch.yml` | ✅ | 已有 |
| 真实可用代码 | ✅ | 28 项测试 + 打包校验 |
| **仓库创建满 1 天** | ❌ | **建于 2026-10-22 01:36 UTC，需等到 10-23 01:36 UTC 之后** |
| **仓库加 `dsh-plugin` topic** | ❌ | 需手动添加 |
| 发布到 npm（推荐） | ⚠️ | 未发布；不发布也能收录，但发 npm 安装更快（跳过 `allowBuilds` 构建授权） |

### 1. 加 topic

仓库主页 → 右侧 About 区域齿轮 → **Topics** 填：

```
dsh-plugin
```

这是 CI 会检查的硬性项。

### 2. 等仓库满 1 天

CI 自动检查仓库年龄。**现在提交必被拒**，等到 **2026-10-23 01:36 UTC**（北京时间 10-23 09:36）之后。

### 3. （可选）发 npm

发布后市场会显示下载量，且安装时跳过构建授权步骤。按 README 的「发布」章节操作即可。

---

## 提 PR 的步骤

```bash
# 1. fork 并 clone
git clone https://github.com/<你的账号>/awesome-dsh-plugin.git
cd awesome-dsh-plugin

# 2. 建文件（内容用上面的 YAML）
mkdir -p data/plugins
# 写入 data/plugins/kemomimi12__dsh-auto-continue.yml

# 3. 提交
git checkout -b add-dsh-auto-continue
git add data/plugins/kemomimi12__dsh-auto-continue.yml
git commit -m "Add kemomimi12/dsh-auto-continue"
git push origin add-dsh-auto-continue
```

然后在 GitHub 上开 PR。

> **不要手工编辑 README**。列表由 `data/plugins/*.yml` 生成，合并后自动重建。

---

## 为什么分类选 `dev`

可选分类：`agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`

本插件在**轮次边界**介入 agent 循环的失败恢复，属于运行时/开发基础设施，不是 UI、不是主题、也不是通知。

`session` 也可考虑（它操作 session 的 `turn/end`），但 `dev` 更贴切——它改的是运行时行为而非会话内容。指南明确说「分类选得不够准，维护者会直接改，不会打回」，所以不必纠结。

---

## 描述为什么这么写

指南明确要求：**描述必须属实，会被对着代码核对；夸大是打回的主因。**

所以描述里只写代码里真有的三件事：

1. **轮次边界续行** —— 监听 `session/event` 的 `turn/end`，用 `Agent.followup()` 排入续行消息
2. **跳过永久错误** —— `PERMANENT_CODES` 集合里有 AUTH / QUOTA / INVALID_REQUEST 等 17 个码
3. **一次故障只续一次** —— 风暴合并，`maxResumesPerStorm: 1`
4. **手动停止优先** —— `aborted` 分支清空状态，且观察 `inbox/spliced` 撤回待发续行

没有写「智能」「自动修复」这类营销词。

---

## 被问到时怎么答

评审可能会问的问题：

**Q：这和 `@deepseek-ai/dsh-llm-retry` 重复吗？**
A：不重复。内置重试在 `agent/request-error` 上重跑**同一步**，且只重试策略里列的失败码；本插件在 `turn/end` 上开**新轮次**。README 里有分工表。

**Q：会不会和 goal 插件抢？**
A：不会。`goalDrives()` 检查到 armed goal 时直接返回，不介入。

**Q：怎么证明能跑？**
A：`npm run verify` 跑 28 项行为测试 + 风暴对比 + 真实故障回放 + 打包校验，全绿。测试不依赖 dsh 运行时。
