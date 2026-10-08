# 预览 Profile 的 compaction 配置示例

状态：可运行示例。任务：P1-12。

职责：给出 `compaction-basic` 在本地 OpenAI 兼容后端上真正可用的预算，并解释为什么
直接沿用上游默认值会让长任务在上下文上限处直接失败。合并进预览 Profile 的
`cordis.patch.yml` 后重启预览即可。只改配置，不新增插件、不改上游源码。

## 为什么必须显式配置

上游 `dsh-web-app` 默认把 compaction 关掉（`cordis.patch.yml` 里
`id: compaction-basic / disabled: true`，`command-compact` 同样）。默认关闭时该 Profile
既没有按压式主动压缩，也没有溢出补救：会话一路增长到 `n_ctx`，请求被拒后
`CONTEXT_WINDOW_EXCEEDED` 原样交给调用方。因此第一步是把两者显式打开。

打开后还不够。`resolveCompactSpec` 的顺序是：

```
messageBudget  = contextWindow − reservedCompletionTokens
pressureBudget = messageBudget − headroomTokens
threshold      = floor(min(contextWindow × thresholdRatio, pressureBudget))
```

`headroomTokens` 默认 **65536**，是一个绝对值而非按窗口比例取值。当后端
`n_ctx = 65536` 时：

```
messageBudget  = 65536 − 16384 = 49152
pressureBudget = 49152 − 65536 = −16384     → 必抛 TargetPressureConfigError
```

按压式压缩被整体跳过，只记一次 warn。`maxTokens` 未设置时还会取
`?? headroomTokens`（`dsh-compaction-basic/lib/index.js`），于是摘要请求的输出预算
也是 65536，本身就装不下——**在 65536 的窗口下，上游默认预算在数学上不可能成立**，
与 Profile 怎么写无关。

## 本例取值

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: false
  config:
    headroomTokens: 8192
    maxTokens: 4096
    thresholdRatio: 0.8
    maxOverflowRetries: 3

- id: command-compact
  name: '@deepseek-ai/dsh-command-compact'
  disabled: false
```

- `headroomTokens: 8192` 必须**小于** `messageBudget`，否则无压力预算。
- `maxTokens: 4096` 必须显式写。不写会继承 `headroomTokens`，而它是**摘要请求的输出
  预算**：阈值处摘要请求为 `prefix(40960) + 输出(4096) = 45056 < 65536` 才装得下。
  摘要预算过大会让压缩在长会话上必然失败，并把溢出错误交给调用方。
- `maxOverflowRetries: 3`（默认 1）。溢出补救是唯一能救回已经越过 `n_ctx` 的路径，
  而它的摘要调用也是最可能失败的单次请求。

自检：`messageBudget 49152`、`pressureBudget 40960`、`threshold 40960`、`retain 7864`。

## 已验证与未验证

已验证：三个 patch 写法中只有能命中真正运行实例的那一个会生效；`threshold` 是对
**整个 prompt** 比较（`tokenMeter` 同时计价系统提示与工具 schema），因此 40960 是在
65536 之前触发，留约 20K 余量。

**未验证**：真实长任务端到端跑到底。运行中的引擎嵌套在 `preset-standard` 的 config
数组里，而 `dsh-app-boot` 的 `applyEntryPatches` 只在 patch 循环之前执行一次
`buildMap`，且仅递归 `group: true` 的条目；`preset-standard` 没有该标记，因此上述
`config` **无法投递**给它，实测仍取默认值。本例是文档化的目标配置，不是已生效的配置。

## 若要真正生效

上游 `headroomTokens` 是固定绝对值，因此不改后端窗口就无法使用默认预算。两条路：

1. 把后端 `n_ctx` 提高到 ≥ 98304 并如实申报 `contextWindow`。此时上游默认值即可成立：
   `messageBudget 114688`、`pressureBudget 49152`、`threshold 49152`，
   且 `prefix + 65536` 的摘要请求也装得下。代价是重启推理服务。
2. 向 dsh 上游提出把 `headroomTokens` 改为按 `contextWindow` 比例取值，或让
   `applyEntryPatches` 支持寻址非 group 条目内部的 id。

本 Profile 的实际生效配置位于 gitignored 的 `.test-runtime/`，因此本目录是该修复唯一
可版本化的载体。