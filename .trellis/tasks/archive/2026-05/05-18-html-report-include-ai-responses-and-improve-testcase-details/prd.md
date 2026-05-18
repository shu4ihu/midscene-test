# HTML Report Include AI Responses and Improve Testcase Details

## Goal

在 `testcases:run` 生成的自定义 summary HTML 中，为每个执行 action 展示 Midscene AI 的响应、思考过程和关键调试信息，同时优化当前“用例明细”表格的可读性，减少用户需要跳转到原生 Midscene report 才能定位问题的成本。

## Requirements

* 自定义 summary HTML 的每个 AI action/step 下展示 AI 详情，默认折叠。
* AI 详情至少包含：
  * Midscene 解析后的 thought / 思考；
  * final output / 响应结果；
  * raw response / 原始模型响应；
  * provider-level reasoning content（如果模型返回）；
  * usage / token、耗时、模型、request id 等调试信息。
* 优化“用例明细”展示为更适合长文本阅读的用例卡片 + 步骤列表布局。
* 每个用例详情提供“打开 Midscene 原生报告”链接，指向本次 run 的 `runData.midsceneReportFile`；不要求深链到具体用例或 action。
* 保留现有 JSON/HTML 产物路径和命令入口。

## Acceptance Criteria

* [ ] 运行 `npm run testcases:run -- --source example/json/testcases.json --limit 1` 后，summary JSON 中每个可执行 AI step 能包含对应 AI dump 摘要字段。
* [ ] summary HTML 中每个 action/step 能展开查看 AI thought、final output、raw response、reasoning content 和 usage，且默认折叠。
* [ ] 如果某个模型/provider 没有返回 reasoning content，HTML 明确显示未返回或安全省略，而不是报错。
* [ ] 原有失败摘要、原始步骤、细化 prompt、error stack 信息仍可查看。
* [ ] 用例明细在多步骤、多失败、长 prompt/长响应情况下仍可读。
* [ ] 每个用例详情中都有“打开 Midscene 原生报告”链接，链接到本次 run 的原生报告文件。

## Definition of Done

* Tests added/updated where practical, or at minimum run existing validation command and inspect generated HTML.
* Lint / syntax check passes for touched JS files.
* 使用一条 testcase 端到端生成 HTML 并验证 AI 详情展示。
* 不泄露 API key；模型 base URL 可保留为已有 summary 中的非密钥配置。

## Technical Approach

采用运行时捕获 Midscene dump 的方式：在 `scripts/lib/bridge-runner.js` 中注册 dump update listener，提取 `Planning`、`Insight/Assert`、`Insight/WaitFor` 等 AI task 的 thought、output、raw response、reasoning content 和 usage，并按 step 执行窗口归并到 step result 的 `aiDetails`。随后由 `scripts/lib/html-report.js` 直接渲染 summary JSON 中的结构化字段。

用例明细从当前大表格优化为卡片式布局：每个用例卡片展示核心元信息、失败摘要、原始步骤、步骤列表、可折叠 AI 详情，以及本次 Midscene 原生报告链接。

## Decision (ADR-lite)

**Context**: Midscene 原生报告已经包含完整 AI dump，但当前 summary JSON/HTML 没有提取，导致排查时必须打开原生报告并手动找 action。

**Decision**: 使用运行时 dump listener 捕获并结构化写入 summary JSON；HTML 只渲染项目自己的结构化数据。AI 详情默认折叠；Midscene report 链接只打开本次 report 文件，不做深链。

**Consequences**: summary JSON 体积会增大，HTML 信息更完整；实现需要处理 dump 多次更新和 step 归属，但避免事后解析大型 React HTML 的脆弱性。

## Out of Scope

* 不修改 Midscene node_modules 源码。
* 不重新实现原生 Midscene report UI。
* 不生成深链到原生报告的具体用例/action。
* 不改变 testcase JSON 输入格式。

## Technical Notes

* 用户提供参考报告：`midscene_run/report/testcases-20260518-172417.html`。
* `scripts/lib/bridge-runner.js`
  * 当前创建 `AgentOverChromeBridge` 时设置了 `generateReport: true` 和 `outputFormat: 'single-html'`。
  * 可通过 Midscene dump listener 或 execution dump 捕获每次 task update 的完整 AI 详情。
* `scripts/lib/html-report.js`
  * 当前 `renderStepDetails()` 只渲染 prompt、错误、原始动作/预期。
  * 需要新增 AI detail 渲染，并优化用例明细布局。
* `node_modules/@midscene/core/dist/types/agent/agent.d.ts`
  * 暴露 `onDumpUpdate` / `addDumpUpdateListener(listener)`。
* `node_modules/@midscene/core/dist/types/types.d.ts`
  * `ExecutionTask` / `ServiceTaskInfo` 包含 `rawResponse`、`thought`、`output`、`usage`、`reasoning_content` 等字段。
* `.trellis/tasks/05-18-html-report-include-ai-responses-and-improve-testcase-details/research/midscene-ai-response-capture.md`
  * 已记录 Midscene dump 中 AI response/thought/reasoning 的字段路径和捕获方案。

## Research References

* [`research/midscene-ai-response-capture.md`](research/midscene-ai-response-capture.md) — Midscene 原生 report/dump 已包含 AI raw response、thought、output、usage 和可选 reasoning content；当前 repo summary 未提取这些字段。