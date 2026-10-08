# 本地 OpenAI 兼容模型提供方接入示例

状态：可运行示例。任务：P0 预览环境加固。

职责：把本地 llama-server / vLLM 通过官方 `dsh-llm-pi-ai` 暴露为一个模型提供方，并给出 compaction 可用的最小配置。只使用官方 Profile patch 层，不新增插件、不改 Harness 源码、不包含密钥（凭据走 `apiKeyEnv` 引用）。

## 用法

把 `cordis.patch.yml` 的条目合并进预览 Profile 的
`.test-runtime/preview/profiles/preview/cordis.patch.yml`，然后重启预览。真实取值必须按后端实际能力填写，不要照抄示例中的数字。

## 关键约束：`maxTokens` 与 `headroomTokens` 决定 compaction 是否启用

`dsh-compaction-basic` 在 `resolveCompactSpec` 中先算消息预算，再算压力预算，任一 ≤ 0 就抛
`TargetPressureConfigError`，按压式 compaction 被整体跳过（只记一次 warn，不报错）：

```
messageBudget  = contextWindow − maxTokens
pressureBudget = messageBudget − headroomTokens      # headroomTokens 默认 65536
threshold      = floor(min(contextWindow × thresholdRatio, pressureBudget))
```

因此下面三种写法都会让会话无界增长、直到溢出后无法补救：

- `maxTokens == contextWindow` → `messageBudget = 0`
- 未设置 `headroomTokens` 且上下文较小 → 默认 65536 超过整个消息预算 → `pressureBudget < 0`
- 模型名标称的上下文大于后端真实值（本例模型名含 `256K`，真实 `n_ctx` 为 65536）

`maxTokens` 必须显著小于 `contextWindow`，并显式设置 `headroomTokens`。本例取值：

```
contextWindow   49152   # 小于后端真实 65536，留出余量
maxTokens        8192
headroomTokens   8192   → messageBudget 40960, pressureBudget 32768
threshold      32768   # 约 32K 触发，保留约 6.5K
```

## `maxTokens` 同时是输出上限，输出截断无法靠 compaction 补救

`maxTokens` 有双重身份，官方代码只显式暴露了其中一面：

- **输入预留**：`messageBudget = contextWindow − maxTokens`（上一节）。
- **逐请求输出上限**：`dsh-agent-loop/README.zh.md` 记录 `agents[].maxTokens` 为
  「正数的逐请求输出 token 上限」；`dsh-llm-pi-ai` 把它作为 `max_tokens` 发给后端。

第二面不会出现在 compaction 预算的报错里，因此极易被忽略：调小它能让按压式 compaction
顺利启用，却同时把单次生成掐短。表现为对话报「已达到输出 token 上限回答被截断」。

关键在于输出截断**不在 compaction 的两个触发条件内**。`dsh-compaction-basic` 只监听：

```
ctx.on("agent/pre-step", …)        # 请求前测得输入超阈值
ctx.on("agent/request-error", …)   # 请求被拒：CONTEXT_WINDOW_EXCEEDED
```

输出截断时请求是**成功**的（HTTP 200），被掐短的是响应，`finish_reason: "length"`
映射为 `{ kind: "max-tokens" }`（`dsh-llm-pi-ai/lib/index.js`），Agent loop 直接结束本轮：

```js
// dsh-agent-loop/lib/index.js
if (finish.kind === "max-tokens") return { kind: "max-tokens" };
```

既不重试也不触发 compaction——而且 compaction 也不可能有用：它压缩的是**输入**，
而这里输入本来就装得下。已产生的部分输出保留，需人工发「继续」。

长文生成类任务（PPT、报告、代码生成）应同时调高输出上限并**如实申报**真实上下文，
不要靠调小 `contextWindow` 省钱。按后端真实 `n_ctx = 65536`、`headroomTokens = 8192`：

| contextWindow | maxTokens | threshold | 单次输出上限 |
|---|---|---|---|
| 49152 | 8192 | 32768 | 8192 ← 长文在此截断 |
| 65536 | 32768 | 24576 | 32768 ← 推荐 |
| 65536 | 49152 | 12288 | 49152 |

申报真实上下文的收益：`maxTokens` 从上下文里扣得更准，白余量不再挤占输出预算。
按压点随之上移并不代表退化——它仍远低于输出上限，且 `retain`（`floor(messageBudget × retainRatio)`）
始终小于 `threshold`，配置依然有效。

## 溢出后为何无法自动补救

溢出补救单次触发，且 `retainTokens = 0`，摘要请求几乎包含整个会话，同样超窗；摘要失败后
`compaction-basic` 记录失败并重放原错误，且不累加重试预算，因此每次继续都会重复同一失败。
这属于「无法压缩一个装不下的上下文」，dsh 文档已声明该边界。配置上面的预算即可提前触发，
避免进入该状态。

## 验证

```bash
# 真实上下文上限（llama-server）
curl -s http://localhost:18000/v1/models | python3 -m json.tool

# 溢出响应形状：应为 {"error":{...,"type":"exceed_context_size_error"}}
# 若看到 {"detail":"{\"error\":..."}}，说明网关把上游错误体重新包了一层，
# OpenAI 兼容客户端读不到 error.code，需修正网关的错误透传。
```

启动日志中不应出现 `TargetPressureConfigError` 或 compaction 的按压配置告警。