# 一次请求与提示词组装

Codex 的 Hello World 就是一句“你好”。在 `codex-ts-demo` 项目中新建任务，发送后得到回答：

> 你好！今天想一起做点什么？

打开[这次正式请求](../evidence/desktop-lab/01-hello/01-request.request.json)：输入框里只有一句问候，请求的 `input` 却有 7 项。其余内容来自哪里？

## 先对上界面里的消息

![Codex Desktop 中的问候、追问与读取 README](../docs/images/desktop-lab/hello-continuation.png)

问候、追问和读取 README 是同一任务里的三轮输入。第一轮的[问候记录](../evidence/desktop-lab/01-hello/manifest.json)中，问候位于 `input[6]`，也就是数组第七项。它的类型、角色和内容如下，省略了消息 ID：

```json
{
  "type": "message",
  "role": "user",
  "content": [
    {
      "type": "input_text",
      "text": "你好\n"
    }
  ]
}
```

`role` 标识消息角色，`content` 保存内容块，`text` 是输入框里的具体文字，末尾换行也保留在记录中。

## 其余六项在告诉模型什么？

模型处理这句问候时，还收到了应用的工作说明、可用工具和项目环境：

| 输入位置 | 内容 | 为什么一起发送 |
| --- | --- | --- |
| `input[0]` | 工具定义 | 描述可使用的接口和参数 |
| `input[1]` 到 `input[4]` | Codex 工作说明、Desktop 能力、技能目录、权限与协作说明 | 给出当前应用的工作方式和可用条件 |
| `input[5]` | 推荐插件、AGENTS 规则、工作目录等环境信息 | 提供本次任务所在环境的约定和背景 |
| `input[6]` | “你好” | 本轮要处理的用户输入 |

`input[5]` 也标为 `user`，内容是客户端附加的规则和环境。因此，要判断文字是否来自输入框，需要看具体内容，不能只看 `user` 标签。

这份可见请求没有 `role: "system"` 消息。应用的主要工作指令出现在 `developer` 消息中，AGENTS 则在前述 `user` 消息的内容块里。日常讨论中的“系统提示词”可能泛指应用附加指令；核对日志时应保留这些实际角色和字段位置。

## 回复在哪份记录里？

那句问候保存在[输出项记录](../evidence/desktop-lab/01-hello/01-request.output-items.json)中，也显示在工作台的“模型输出”里。它是一条助手消息，`role` 为 `assistant`，`phase` 为 `final_answer`。

这次没有工具调用，模型直接生成文字，运行程序将它显示在 Desktop 中。请求虽然带有工具定义，模型仍可以直接回答。

本章直接使用工作台的“模型输出”对照回答。需要追查它与原始响应文件的关系时，可读[流式输出](14-streaming.md#为什么完成事件里的-output-是空的)。

<details>
<summary>深入核对：7 项输入里的所有内容块</summary>

### 消息与内容块的边界

`input[0]` 的类型是 `additional_tools`，它没有 `content` 数组。其余消息合计包含 11 个内容块。

| 位置 | 角色 | 实际内容 |
| --- | --- | --- |
| `input[0].tools` | developer | 4 个工具命名空间的定义 |
| `input[1].content[0]` | developer | 以 `You are Codex, an agent based on GPT-6` 开头的工作说明 |
| `input[2].content[0]` | developer | `<app-context>`，Desktop 能力说明 |
| `input[2].content[1]` | developer | `<skills_instructions>`，技能规则、名称、描述和位置 |
| `input[2].content[2]` | developer | `<permissions instructions>`，权限配置说明 |
| `input[2].content[3]` | developer | `<collaboration_mode>`，本次为 Default |
| `input[3].content[0]` | developer | `<multi_agent_role>`，当前 Agent 的协作角色说明 |
| `input[4].content[0]` | developer | `<multi_agent_mode>`，本次协作使用约束 |
| `input[5].content[0]` | user | `<recommended_plugins>`，推荐插件清单 |
| `input[5].content[1]` | user | `# AGENTS.md instructions` 与 `<INSTRUCTIONS>` 包装的全局规则 |
| `input[5].content[2]` | user | `<environment_context>`，工作目录、Shell、日期、时区等 |
| `input[6].content[0]` | user | `你好\n` |

其中 `<app-context>` 等标签只是文本包装，消息角色仍以协议字段为准。此时 demo 尚未加入后续实验的项目 AGENTS 文件，规则块只有本次全局约定；第 6 章会比较加入项目约定后的变化。

工具定义位于 `input[0].tools`，包含 `functions`、`clock`、`collaboration`、`mcp__cua_repl` 四个命名空间，共 13 个可见工具条目。这里没有把外层 `exec` 能编排的下层能力算成额外注册条目。

### 请求级配置与来源

本次请求的外层字段节选如下，其余字段可在工作台展开：

```json
{
  "type": "response.create",
  "model": "gpt-6-astra",
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "store": false,
  "stream": true
}
```

请求没有顶层 `instructions` 或 `tools`；完成事件的 `response.instructions` 为 `null`，`response.tools` 回显工具配置。这些位置要分别查看。`model` 是请求中的模型标识，单凭它无法确认上游实际部署身份。

[客户端请求](../evidence/desktop-lab/01-hello/01-request.request.json)与[CPA 上游快照](../evidence/desktop-lab/01-hello/01-request.upstream.json)的字段和值相同，可见 CPA 转发前后保留了这些数据。上游服务内部未记录的处理仍不可见。

</details>

<details>
<summary>深入核对：预热与正式请求</summary>

CPA 还记录了一次[预热请求](../evidence/desktop-lab/01-hello/00-prewarm.request.json)，其中 `generate: false`，只有工具定义与基础工作说明两项输入，没有生成普通回答。它们与正式请求的前两项深比较相同。

因此，在列表里选择“正式请求”才能看到完整的七项输入和问候回答。预热单独计数，不是用户额外发送了一次“你好”。各份记录仍可从[实验清单](../evidence/desktop-lab/01-hello/manifest.json)进入；用量的读法集中在[上下文管理](05-context.md#重发引用缓存各自改变什么)。

</details>

## 这句问候用了多少 token？

同一次响应的 `usage` 记录了计量结果：输入 32,774 个 token，输出 13 个，没有命中缓存。其中“你好”只占 6 个。`usage.attribution.items` 还按输入项的 `id` 拆分了输入 token：

| 输入位置 | 内容 | 输入 token |
| --- | --- | ---: |
| `input[0]` | 工具定义 | 14,519 |
| `input[1]` | Codex 工作说明 | 4,152 |
| `input[2]` | Desktop 能力、技能目录、权限与协作说明 | 11,578 |
| `input[3]`、`input[4]` | 多 Agent 角色与约束 | 539、56 |
| `input[5]` | 推荐插件、AGENTS 规则、环境信息 | 1,922 |
| `input[6]` | “你好” | 6 |

七项合计 32,772；另有 2 个输入 token 归在本次回答消息的 `id` 下，与总数 32,774 相符。这 2 个 token 具体对应什么，记录中没有说明。

`input[2]` 的计量也拆成四段：1,410、9,922、67 和 179。按内容块顺序对应，技能目录一块就接近一万。也就是说，这次请求的大部分输入在用户开口之前就已确定：工具定义和技能目录两项合计约占四分之三。[第 5 章](05-context.md#重发、引用、缓存各自改变什么)会看到，后续请求的 `cached_tokens` 不再为 0。

数字来自[本次响应记录](../evidence/desktop-lab/01-hello/01-request.response.json)的 `response.usage`。不同版本的工具与技能数量不同，复现时的数值也会不同，比较时看各部分的比例即可。

## 自己找到两条 user 消息

展开正式请求中的 `input[5]` 和 `input[6]`。它们的角色相同，但来源不同。各找一个内容特征，说明哪条来自输入框，哪条是客户端附加信息。

<details>
<summary>核对答案</summary>

`input[6]` 包含“你好”，与截图中的输入对应；`input[5]` 包含 AGENTS 规则、工作目录和环境标签。判断来源需要看内容，不能只凭 `role: "user"`。

</details>

现在已经能区分输入框里的文字与应用附加的内容。下一章让它读取 README，观察文件正文怎样进入后续请求。

[回到导读](introduction.md) · [下一章：工具系统](02-tools.md)
