# Improve Testcase Step Coverage for Interactive Assertions

## Goal

改进 testcase step 细化/执行策略，避免把静态页面字段展示和交互属性（如“不可复制”“可查看在职人员”“可点击跳转”）混在同一个 `assert` 里导致误失败。目标是让静态可见性断言与交互验证拆开执行：静态字段展示用独立 assert 验证，交互属性自动生成单独的 act/assert 验证步骤。

## Requirements

* 静态字段展示断言不应包含无法通过当前页面静态状态验证的交互属性。
* 从 expectedText 中识别带括号说明的交互属性，例如：`客户（不可复制）`、`订单团队（可查看在职人员）`。
* 对交互属性自动生成独立验证步骤，而不是只标记人工：
  * `不可复制`：生成一个 act 尝试选中/复制对应字段，再生成 assert 判断复制行为是否被禁止或页面是否体现不可复制。
  * `可查看...`：生成一个 act 点击或打开对应字段/入口，再生成 assert 判断是否出现对应信息、弹层、人员列表或可查看状态。
  * `跳转/可点击`：生成 act 点击入口，再生成 assert 判断是否跳转或出现目标详情。
* 静态 assert 仍验证字段文案、顺序、布局、已展示内容。
* 生成的 summary report 应能看出哪些步骤来自静态断言，哪些步骤来自交互属性验证。
* 保留现有命令入口和 testcase JSON 输入格式。

## Acceptance Criteria

* [ ] `SQ-81350` 的静态字段顺序/展示可以被单独 assert，不再因为“不可复制”无法截图判断而失败。
* [ ] `客户（不可复制）` 被拆出为单独交互验证步骤。
* [ ] `订单团队（可查看在职人员）` 被拆出为单独交互验证步骤。
* [ ] 交互属性从静态 assert 中移除，并在 refined steps / report 中可见。
* [ ] 现有 dry-run 和 run 模式仍可执行。

## Definition of Done

* 语法检查通过。
* 使用 `npm run testcases:dry-run -- --source example/json/testcases.json --limit 1` 或等价方式确认 refined steps 拆分结果。
* 使用一条 testcase 端到端验证 summary HTML 能清楚展示拆分后的步骤。

## Technical Approach

在 `scripts/lib/refine-steps.js` 中增强 raw expectedText 的拆分逻辑：

1. 解析 expectedText 中按行/编号列出的预期项。
2. 将每个预期项拆成：
   * static label/text，例如 `客户`、`订单团队`；
   * interaction note，例如括号中的 `不可复制`、`可查看在职人员`。
3. 构造静态 expectedText，只保留字段展示、顺序、静态内容。
4. 为每个 interaction note 追加独立 refined steps：
   * `act`：要求 Midscene 执行对应交互验证动作；
   * `assert`：判断该交互属性是否成立。
5. 为这些自动生成的 step 增加 prompt 文案，让 report 中可以看出来源是“交互属性验证”。

## Decision (ADR-lite)

**Context**: 当前单个 assert 把静态字段展示和交互属性混在一起，AI 即使确认字段展示正确，也会因为截图无法证明“不可复制”等交互属性而判失败。

**Decision**: 采用自动验证策略：交互属性不再保守标记 manual，而是自动生成单独 act/assert。静态 assert 只验证静态页面状态。

**Consequences**: 覆盖更完整，能真实验证“不可复制/可查看/跳转”等要求；但执行可能点击页面、打开弹窗或跳转，需沿用现有 safe mode/destructive 判断，后续可能需要更细的交互风险分类。

## Technical Notes

* Primary file: `scripts/lib/refine-steps.js`。
* Current execution support already exists in `scripts/lib/bridge-runner.js` for `manual-note` / `act` / `assert` / `wait`。
* Example source: `example/json/testcases.json` first case `SQ-81350`。
* Current `buildAssertPrompt()` uses full expectedText as mandatory expected state; this is the source of the mixed assertion behavior.

## Out of Scope

* 不修改原始 testcase JSON。
* 不引入新的第三方依赖。
* 不对所有自然语言测试预期做完整语义解析；MVP 先覆盖常见括号交互属性和关键词。
* 不保证所有交互都一定能成功自动验证；如果页面缺少入口或数据，仍应由对应交互 assert 明确失败。