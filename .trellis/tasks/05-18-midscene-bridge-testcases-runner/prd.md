# Midscene Bridge Testcases Runner

## Goal

构建并验证一个通用的 Midscene Bridge 用例执行 runner。它能从 JSON 用例文件读取人工测试用例，细化为 Midscene 可执行步骤，连接真实 Chrome Bridge 环境执行，并生成 JSON/HTML 汇总报告。

## What I already know

* 默认示例用例位于 `example/json/testcases.json`，但生产环境会有很多不同业务，runner 不能强耦合当前示例业务。
* 已实现通用 `--source <path>` 参数，示例 JSON 只是默认输入。
* 真实 Bridge 执行需要 Chrome、Midscene Chrome 扩展、可用模型配置、已登录目标系统页面。
* 默认 safe mode 会跳过可能改变业务数据的动作；需要显式 `--allow-destructive` 才执行提交/保存/关闭等动作。
* 执行失败必须记录失败原因，不能只记录 failed/error 状态。

## Assumptions (temporary)

* 生产用例 JSON 仍大致保留 TestLink-like 结构：`test_suites[].test_cases[].steps[]`，或至少能映射为 suite/case/step。
* 真实执行优先使用当前已登录 Chrome tab，而不是脚本内处理登录。
* 第一次真实执行应先跑单用例或小批量，避免误改业务数据。

## Open Questions

* 真实执行时，用户希望使用当前已登录页面，还是由脚本打开指定 URL？

## Requirements (evolving)

* Runner 必须支持从任意 JSON 路径读取用例。
* Runner 必须支持 dry-run 验证解析、细化和报告生成。
* Runner 必须支持 current tab 与 URL 两种 Bridge 连接方式。
* Runner 必须默认 safe mode，避免直接执行破坏性业务操作。
* Runner 必须生成自定义 HTML 汇总报告和 JSON 结果。
* 每个失败、阻塞、跳过或错误的 case/step 必须记录结构化原因：失败类型、失败说明、原始步骤号、原始动作、原始预期、错误 message 和 stack。
* HTML 报告采用“摘要 + 可展开详情”：默认显示 case 级失败类型和失败原因，展开后查看 step prompt、原始动作/预期、错误 message 和 stack。

## Acceptance Criteria (evolving)

* [x] `npm run testcases:dry-run -- --source example/json/testcases.json --limit 1` 能生成报告。
* [x] JS 语法检查通过。
* [ ] 用户准备 Chrome Bridge 环境后，`npm run testcases:run -- --source <json> --limit 1` 能连接当前 tab 并输出报告。
* [ ] 单用例失败时不会丢失汇总报告。
* [ ] HTML 报告能按失败类型汇总，并能定位到 externalId、case name、source step number。
* [ ] JSON 结果保留完整失败原因字段，便于后续二次分析。

## Definition of Done

* Tests or smoke checks completed where applicable.
* Dry-run and real-run usage documented in conversation.
* Report outputs verified.
* Risky destructive operations gated by explicit flag.

## Out of Scope

* 不在本任务内自动登录业务系统。
* 不为每种生产 JSON 格式单独写业务适配器，除非提供具体格式样本。
* 不默认执行提交、保存、关闭、删除等可能改变生产数据的步骤。

## Technical Notes

* `scripts/run-testcases.js` 是主入口。
* `scripts/lib/testcase-loader.js` 负责 JSON 加载、扁平化和 HTML 清洗。
* `scripts/lib/refine-steps.js` 负责规则化细化和风险标记。
* `scripts/lib/bridge-runner.js` 负责 `AgentOverChromeBridge` 连接和执行。
* `scripts/lib/html-report.js` 负责 JSON/HTML 汇总报告。
* `docs/web-api-reference-en.md` 中 Bridge API 要求先 `connectCurrentTab` 或 `connectNewTabWithUrl`，再执行 AI 操作。
