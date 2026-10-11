# Codex 是如何工作的

给 Codex 发送“你好”，就是这份教程的 Hello World。

这里用一个简单的 TypeScript 项目，在真实 Codex Desktop 中做实验。你可以逐项展开收录的请求、响应和请求中可见的完整上下文，把界面操作与模型的输入输出对应起来。文件读取、代码修复及 Skills、Hooks、MCP 的使用，都有相应记录可查。

[在线阅读](https://chrichuang218.github.io/how-codex-works/) · [完整修复案例](https://chrichuang218.github.io/how-codex-works/#/lesson/03-agent-loop?section=agent-loop-timeline)

先打开“你好”的[真实请求与上下文](https://chrichuang218.github.io/how-codex-works/#/lesson/01-request?experiment=01-hello&stage=1&view=request)，再对照[响应与输出](https://chrichuang218.github.io/how-codex-works/#/lesson/01-request?experiment=01-hello&stage=1&view=output)。输入框里的两个字，只是模型收到的内容之一。

[![Codex 修复总价错误后运行类型检查、测试和示例](docs/images/desktop-lab/fix-result.png)](https://chrichuang218.github.io/how-codex-works/#/lesson/03-agent-loop?section=agent-loop-timeline)

项目起初把单价 10 元和数量 3 相加，输出 13 元；测试要求得到 30 元。后续章节沿同一个项目继续学习上下文、规则、技能、MCP、计划和协作。

## 阅读路线

课程分为四个阶段、16 个主题。按顺序阅读正文，遇到需要核对的字段，再展开“深入核对”或查看工作台里的完整输入输出。左侧当前章的箭头可以收起小节，长目录可独立滚动。

无需安装即可在线阅读。每章先说明实验起点，工作台提示本节要比较的证据；术语可就地展开，搜索会定位到命中段落。网站提供专注阅读和本地“继续阅读”，只记录阅读位置，不把翻页或读完自动计为掌握。前三章末尾有一组使用真实记录的迁移练习。

第 3 章的时间线串起修复过程中的五次请求。每个节点显示模型的输入、调用和结果去向，并链接到对应证据。公开记录可以展开、复制和下载。

| 阶段 | 章节 |
| --- | --- |
| 看懂一次运行 | [01 请求与提示词](course/01-request.md) · [02 工具系统](course/02-tools.md) · [03 Agent Loop](course/03-agent-loop.md) |
| 信息从哪里来 | [04 任务与会话](course/04-session.md) · [05 上下文管理](course/05-context.md) · [06 AGENTS.md](course/06-agents.md) · [07 Skills](course/07-skills.md) · [08 记忆](course/08-memory.md) |
| 扩展能力与控制执行 | [09 MCP](course/09-mcp.md) · [10 Hooks](course/10-hooks.md) · [11 权限](course/10-permissions.md) · [12 Plan Mode](course/11-plan.md) · [13 多 Agent](course/12-multi-agent.md) |
| 完成复杂任务与复盘 | [14 目标与续跑](course/13-autonomy.md) · [15 流式输出](course/14-streaming.md) · [16 架构与验证](course/15-architecture.md) |

[术语与实例](GLOSSARY.md)用于查阅字段和概念。

## 跟着做一次

需要 Codex Desktop、Node.js 24 或更高版本。只有要采集自己的请求日志时才需要 CPA：它在本实验中负责转发并记录 Desktop 与上游之间的请求和响应。[导读的准备说明](course/introduction.md#选择阅读或亲自复现)提供用途、项目入口和日志核对方法。

1. 把 [examples/01-baseline](examples/01-baseline) 复制到自己的独立目录。
2. 在复制后的目录运行下面的命令，确认起始故障。
3. 将目录加入 Codex Desktop 项目区，新建任务，发送“你好”，从[第一章](course/01-request.md)开始对照请求。

```powershell
npm ci
npm start
npm run typecheck
npm test
```

起始程序输出 13，类型检查通过，测试以 `13 !== 30` 失败。第 3 章修复这个错误，后续分别提供[修复版](examples/07-fixed/README.md)、[MCP 版](examples/13-mcp/README.md)和[折扣版](examples/14-discount/README.md)作为对照。

Hooks、后台命令、补丁恢复和文字进度的脚本与测试见[运行状态练习](examples/runtime-lab/README.md)，其中分别提供起始文件和结果文件。

复现前先确认该章使用的项目状态。你的回答措辞和调用次数可能不同，可以对照输入、文件与执行结果判断差异。

## 怎样对照日志

[实验索引](evidence/desktop-lab/index.json)关联 43 组实验、110 个请求阶段，其中 3 次为预热。每个阶段可以查看客户端请求、CPA 上游请求、流式事件、完成事件和输出项。

公开记录已脱敏，敏感内容以占位符替换；“完整上下文”限于所保存请求中可见的内容。

截图展示操作和结果，工作台可切换请求、输出、工具往返和完整文件。判断工具是否执行、文件是否改变，还需要核对本地事件、文件内容与退出码。

第 10 章集中讲解 Hooks 的配置与信任状态，以及编号注入、补丁拦截、执行结果记录。第 14 章对照普通文字进度、后台进程回收和补丁错误恢复，Plan Mode 章专注于澄清需求与确认实施。

[第 8 章](course/08-memory.md)对照项目文件笔记与原生记忆：一条偏好经过后台提取和整合后，怎样进入新任务？整合前的“不知道”和整合后的开关对照都有对应请求，可以查到答案的来源。

`output-items.json` 从流式事件中提取完整输出项。有些完成事件的 `output` 为空，回答和工具调用仍可在此前的流式事件中找到，第 15 章会解释它们的关系。

## 本地阅读与贡献

在本仓库根目录运行：

```powershell
npm ci
npm run dev
```

网站使用 Vite、Markdown 和按需加载的证据文件。[course/catalog.json](course/catalog.json)定义章节顺序，`course/` 保存正文，`evidence/desktop-lab/` 保存实验证据。

内容主归属和迁移决定见[章节整理清单](docs/content-reorganization.md)。修改标题时同步 [固定小节 ID](course/section-ids.json)，已迁走的小节在目录的 `sectionRedirects` 中给出准确目标；不要重新按当前位置给旧标题编号。

工作台以 `readingGuide.targets` 的首项作为本章默认实验、请求和视图；同一请求的 `input` / `content` 目标决定默认展开哪些内容。维护观察重点时同步这些入口，不按文本长度推测重要性。精确分享链接优先使用链接指定的位置，完整原文始终保留。

验证运行 `npm run check`、`npm run build`、`npm run check:site`。浏览器回归读取 `dist/` 并启动临时本地服务，需要系统已安装 Google Chrome；它同时核对完整证据、旧链接及阅读交互。也可用 `node scripts/check-reading.mjs https://chrichuang218.github.io/how-codex-works/` 对线上站点执行阅读回归。发布构建的 `build-info.json` 记录版本与提交，便于核对部署。

欢迎补充另一个版本的复现结果，或指出某段解释与证据不符。提交问题时，请附章节、操作、实际结果及脱敏后的相关片段。

[发布记录](CHANGELOG.md) · [维护记录](PROGRESS.md)

## 致谢

🙏 感谢 [LINUX DO](https://linux.do/) 社区的支持与讨论。
