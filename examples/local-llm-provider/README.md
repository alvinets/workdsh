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