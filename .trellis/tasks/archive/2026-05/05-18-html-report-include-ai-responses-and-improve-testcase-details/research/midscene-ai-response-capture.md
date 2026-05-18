# Research: Midscene AI response and reasoning capture

- **Query**: Research how this repo/Midscene exposes AI response and reasoning/thinking data during aiAct/aiAssert/aiWaitFor or report generation. Inspect node_modules @midscene core/web APIs and existing generated report JSON/HTML structures.
- **Scope**: internal
- **Date**: 2026-05-18

## Findings

### Files Found

| File Path | Description |
|---|---|
| `node_modules/@midscene/core/dist/types/types.d.ts` | Public dump/task typings: `ServiceTaskInfo`, `PlanningAIResponse`, `ExecutionTask`, `ExecutionDump`, `AgentOpt`. |
| `node_modules/@midscene/core/dist/types/agent/agent.d.ts` | Agent API signatures for `aiAct`, `aiAssert`, `aiWaitFor`, `onDumpUpdate`, `addDumpUpdateListener`. |
| `node_modules/@midscene/core/dist/lib/agent/agent.js` | Agent runtime wiring: report generation, dump update listeners, `aiAct` return value, `aiAssert` return behavior. |
| `node_modules/@midscene/core/dist/lib/agent/tasks.js` | Task execution logic that copies raw AI responses, parsed thought/output, usage, and reasoning into task dumps. |
| `node_modules/@midscene/core/dist/lib/service/index.js` | Insight/locate service dump creation; stores raw/parsed responses and reasoning in `ServiceDump.taskInfo`. |
| `node_modules/@midscene/core/dist/lib/ai-model/llm-planning.js` | Planning model call; returns `rawResponse`, `usage`, `reasoning_content`, `thought`, `finalizeMessage`. |
| `node_modules/@midscene/core/dist/lib/ai-model/inspect.js` | Locate/extract model calls; returns `rawResponse`, parsed result, `usage`, `reasoning_content`. |
| `node_modules/@midscene/core/dist/lib/ai-model/service-caller/index.js` | Low-level OpenAI-compatible call wrapper; extracts `message.reasoning_content` / streaming reasoning deltas and usage metadata. |
| `node_modules/@midscene/core/dist/lib/report-generator.js` | Appends serialized per-execution dumps into generated report HTML; can optionally persist `*.execution.json`. |
| `node_modules/@midscene/core/dist/lib/dump/html-utils.js` | Emits `<script type="midscene_web_dump">...</script>` tags containing escaped serialized dump JSON. |
| `node_modules/@midscene/web/dist/types/playwright/index.d.ts` | `PlaywrightAgent` extends core Agent; web APIs inherit core dump/report APIs. |
| `node_modules/@midscene/web/dist/types/puppeteer/index.d.ts` | `PuppeteerAgent` extends core Agent; web APIs inherit core dump/report APIs. |
| `node_modules/@midscene/web/dist/types/web-element.d.ts` | `WebPageAgentOpt = AgentOpt & WebPageOpt`, so report/dump options are available to web agents. |
| `scripts/lib/bridge-runner.js` | Current repo runner creates `AgentOverChromeBridge`, calls `aiAct`/`aiAssert`/`aiWaitFor`, but does not copy AI response fields into summary step results. |
| `scripts/lib/html-report.js` | Current custom summary HTML renders prompts/errors only; no AI response/thought fields are rendered. |
| `midscene_run/summary/test-results-20260518-172417.json` | Existing generated run summary JSON; references Midscene report file but step objects do not include AI response/thought data. |
| `midscene_run/report/testcases-20260518-172417.html` | Existing Midscene report HTML; contains `midscene_web_dump` script tags with raw AI response, parsed thought/output, usage, and service task info. |

### Code Patterns

#### 1. Midscene dump shape already includes AI raw response, thought, reasoning, usage

Types show the fields are part of Midscene's execution/report dump model:

- `ServiceTaskInfo` includes `rawResponse?: string`, `formatResponse?: string`, `usage?: AIUsageInfo`, `reasoning_content?: string` at `node_modules/@midscene/core/dist/types/types.d.ts:115-123`.
- `ServiceExtractResult` includes `thought?: string`, `usage?: AIUsageInfo`, `reasoning_content?: string` at `node_modules/@midscene/core/dist/types/types.d.ts:156-160`.
- `PlanningAIResponse` includes `usage?: AIUsageInfo`, `rawResponse?: string`, `reasoning_content?: string`, `output?: string` at `node_modules/@midscene/core/dist/types/types.d.ts:218-228`.
- `ExecutionTask` includes top-level `thought?: string`, `usage?: AIUsageInfo`, `reasoning_content?: string`, plus `log`/`output` at `node_modules/@midscene/core/dist/types/types.d.ts:291-317`.
- `ExecutionDump` serializes `tasks` at `node_modules/@midscene/core/dist/types/types.d.ts:318-345` and runtime `toJSON()` preserves each task object at `node_modules/@midscene/core/dist/lib/types.js:118-133`.

Practical field paths observed in dumps:

- `aiAct` / planning:
  - `execution.tasks[].type === "Planning"`
  - `task.param.userInstruction` = original prompt
  - `task.log.rawResponse` = raw XML-ish model response with escaped Midscene tags
  - `task.output.thought` = parsed `<thought>`
  - `task.output.output` = parsed `<complete>` final message / AI action result
  - `task.usage` = token/time/model/request metadata with intent `planning`
  - `task.reasoning_content` = provider reasoning content when available
- `aiAssert` / `aiWaitFor` insight checks:
  - `execution.tasks[].type === "Insight"`, `subType === "Assert"` or `"WaitFor"`
  - `task.param.dataDemand` = assertion/wait prompt
  - `task.thought` = parsed `<thought>`
  - `task.output` = boolean result for assert/wait checks
  - `task.log.taskInfo.rawResponse` = raw XML extraction response
  - `task.log.taskInfo.formatResponse` = parsed JSON string
  - `task.log.taskInfo.usage` and `task.usage` = usage metadata
  - `task.log.taskInfo.reasoning_content` and/or `task.reasoning_content` = provider reasoning content when available

#### 2. Low-level model calls capture provider reasoning content separately from Midscene `<thought>`

`callAI` accumulates provider reasoning from OpenAI-compatible responses:

- Streaming: reads `chunk.choices?.[0]?.delta?.reasoning_content` and appends it to `accumulatedReasoning` at `node_modules/@midscene/core/dist/lib/ai-model/service-caller/index.js:293-303`.
- Non-streaming: reads `result.choices[0].message?.reasoning_content || ''` at `node_modules/@midscene/core/dist/lib/ai-model/service-caller/index.js:356-358`.
- Return value includes `reasoning_content: accumulatedReasoning || void 0` and normalized usage at `node_modules/@midscene/core/dist/lib/ai-model/service-caller/index.js:391-395`.
- `callAIWithObjectResponse` forwards `reasoning_content` at `node_modules/@midscene/core/dist/lib/ai-model/service-caller/index.js:406-419`.

This is distinct from Midscene prompt-level `<thought>` fields. `<thought>` is parsed into `task.output.thought` for planning or `task.thought` for insight; provider `reasoning_content` is exposed as `task.reasoning_content` when the model/provider returns it.

#### 3. `aiAct` captures planning raw response/thought/output in task dumps, while direct return is only final output string

Agent API:

- `aiAct(taskPrompt, opt?)` returns `Promise<string | undefined>` at `node_modules/@midscene/core/dist/types/agent/agent.d.ts:126`.
- Runtime calls `taskExecutor.action(...)` then returns only `actionOutput?.output` at `node_modules/@midscene/core/dist/lib/agent/agent.js:381-425`.

Task capture happens in `TaskExecutor.runAction`:

- Planning call returns `rawResponse`, `usage`, `reasoning_content`, `thought`, and `finalizeMessage` from `planResult` at `node_modules/@midscene/core/dist/lib/agent/tasks.js:204-221`.
- It writes `executorContext.task.log = { rawResponse }` at `node_modules/@midscene/core/dist/lib/agent/tasks.js:206-209`.
- It writes `executorContext.task.usage = withUsageIntent(usage, 'planning')` at `node_modules/@midscene/core/dist/lib/agent/tasks.js:210`.
- It writes `executorContext.task.reasoning_content = reasoning_content` at `node_modules/@midscene/core/dist/lib/agent/tasks.js:211`.
- It writes parsed planning output including `thought` and final `output` at `node_modules/@midscene/core/dist/lib/agent/tasks.js:212-222`.

The planning model itself returns these values from `llm-planning.js`:

- Calls `callAI` and destructures `{ content: rawResponse, usage, reasoning_content }` at `node_modules/@midscene/core/dist/lib/ai-model/llm-planning.js:186-188`.
- Returns `rawResponse`, `usage`, `reasoning_content`, parsed actions/thought/finalize fields at `node_modules/@midscene/core/dist/lib/ai-model/llm-planning.js:216-224`.

#### 4. `aiAssert` exposes parsed assertion thought only if `keepRawResponse` is passed; otherwise details still exist in dump

Agent API:

- `aiAssert(assertion, msg?, opt?)` can return `{ pass, thought, message } | undefined` at `node_modules/@midscene/core/dist/types/agent/agent.d.ts:155-159`.
- Runtime only returns that object when `opt?.keepRawResponse` is true; otherwise it throws on failure and returns `undefined` on pass at `node_modules/@midscene/core/dist/lib/agent/agent.js:517-554`.

Regardless of direct return behavior, the insight task dump captures the detail:

- `createTypeQueryTask` assigns `task.log = { dump, rawResponse: dump.taskInfo?.rawResponse }` at `node_modules/@midscene/core/dist/lib/agent/tasks.js:291-300`.
- It assigns `task.usage = withUsageIntent(dump.taskInfo?.usage, 'insight')` and copies `dump.taskInfo.reasoning_content` to `task.reasoning_content` at `node_modules/@midscene/core/dist/lib/agent/tasks.js:300-302`.
- It returns `thought` from extraction and sets `task.thought = thought` on failed assertions before throwing at `node_modules/@midscene/core/dist/lib/agent/tasks.js:333-350`.
- On successful task completion, `TaskRunner.flush()` merges the executor return (`thought`, `output`, `log`) into the task via `Object.assign(task, returnValue)` at `node_modules/@midscene/core/dist/lib/task-runner.js:184-188`.

The underlying service extraction stores raw and parsed response:

- `Service.extract` calls `AiExtractElementInfo` and captures `parseResult`, `rawResponse`, `usage`, `reasoning_content` at `node_modules/@midscene/core/dist/lib/service/index.js:157-178`.
- It creates `taskInfo` with `rawResponse`, `formatResponse`, `usage`, `reasoning_content` at `node_modules/@midscene/core/dist/lib/service/index.js:201-209`.
- It returns `data`, `thought`, `usage`, `reasoning_content`, `dump` at `node_modules/@midscene/core/dist/lib/service/index.js:228-234`.

#### 5. `aiWaitFor` uses repeated Insight `WaitFor` tasks; the same dump paths apply

Agent `aiWaitFor` delegates to `taskExecutor.waitFor(...)` with timeout/check interval defaults at `node_modules/@midscene/core/dist/lib/agent/agent.js:555-561`.

`TaskExecutor.waitFor` creates repeated query tasks with type `WaitFor` until one returns truthy or timeout:

- Builds `queryTask = createTypeQueryTask('WaitFor', ...)` at `node_modules/@midscene/core/dist/lib/agent/tasks.js:368-390`.
- `createTypeQueryTask` stores the raw/parsed/usage/reasoning fields the same way as `Assert` at `node_modules/@midscene/core/dist/lib/agent/tasks.js:291-350`.
- On timeout it appends an error plan with the last `thought` via `session.appendErrorPlan(`waitFor timeout: ${errorThought}`)` at `node_modules/@midscene/core/dist/lib/agent/tasks.js:395-413`.

#### 6. Report HTML is a serialized execution dump transport, not just a UI

Report generator writes current execution dumps into HTML:

- Agent installs `hooks.onTaskUpdate`, calls `runner.dump()`, `appendExecutionDump`, `writeOutActionDumps`, `reportGenerator.flush()`, then invokes dump update listeners with `(dumpString, executionDump)` at `node_modules/@midscene/core/dist/lib/agent/agent.js:777-789`.
- `writeOutActionDumps` sends the execution to `reportGenerator.onExecutionUpdate(...)` at `node_modules/@midscene/core/dist/lib/agent/agent.js:205-212`.
- `ReportGenerator` wraps an `ExecutionDump` in `ReportActionDump` at `node_modules/@midscene/core/dist/lib/report-generator.js:134-145`.
- In single-html mode it appends `generateDumpScriptTag(serialized, attrs)` to the report at `node_modules/@midscene/core/dist/lib/report-generator.js:146-158`.
- Directory mode does the same and may also persist execution JSON at `node_modules/@midscene/core/dist/lib/report-generator.js:159-190`.
- `generateDumpScriptTag` emits `<script type="midscene_web_dump" ...>{json}</script>` at `node_modules/@midscene/core/dist/lib/dump/html-utils.js:326-329`.

Useful APIs/options:

- `Agent.onDumpUpdate` / `addDumpUpdateListener(listener: (dump, executionDump?) => void)` are exposed in types at `node_modules/@midscene/core/dist/types/agent/agent.d.ts:31-32` and `node_modules/@midscene/core/dist/types/agent/agent.d.ts:171-176`.
- Runtime invokes listeners after every task update with full dump string and current `ExecutionDump` at `node_modules/@midscene/core/dist/lib/agent/agent.js:780-786`.
- `AgentOpt.persistExecutionDump?: boolean` is defined at `node_modules/@midscene/core/dist/types/types.d.ts:580-587` and defaults to `false` at `node_modules/@midscene/core/dist/lib/agent/agent.js:740-743`.
- `ReportGenerator` writes `{n}.execution.json` when `persistExecutionDump` is true at `node_modules/@midscene/core/dist/lib/report-generator.js:176-190`.

#### 7. Web agents inherit core Agent APIs/options

- `PlaywrightAgent extends PageAgent<PlaywrightWebPage>` where `PageAgent` is `@midscene/core/agent` at `node_modules/@midscene/web/dist/types/playwright/index.d.ts:1-12`.
- `PuppeteerAgent extends PageAgent<PuppeteerWebPage>` at `node_modules/@midscene/web/dist/types/puppeteer/index.d.ts:1-10`.
- `WebPageAgentOpt = AgentOpt & WebPageOpt` at `node_modules/@midscene/web/dist/types/web-element.d.ts:1-5`, so `generateReport`, `reportFileName`, `persistExecutionDump`, `outputFormat`, `reportAttributes`, and listener APIs are available on web/bridge agents through the core Agent.

#### 8. Current repo summary artifacts omit AI response fields

Current runner:

- Creates `AgentOverChromeBridge` with `generateReport: true`, `reportFileName`, `groupName`, `outputFormat: 'single-html'`, and report attributes at `scripts/lib/bridge-runner.js:3-18`.
- Calls `agent.aiAct(step.prompt)` without storing the returned output or execution dump details at `scripts/lib/bridge-runner.js:145-159`.
- Calls `agent.aiAssert(step.prompt)` without `keepRawResponse` and without storing assertion thought/result at `scripts/lib/bridge-runner.js:161-163`.
- Calls `agent.aiWaitFor(step.prompt)` without storing wait task thought/result at `scripts/lib/bridge-runner.js:166-168`.
- Returns only `{ results, midsceneReportFile }` at `scripts/lib/bridge-runner.js:50`.

Current custom summary HTML/JSON:

- Summary JSON `midscene_run/summary/test-results-20260518-172417.json` has `midsceneReportFile` at line 46 and step objects with `prompt`, `status`, `durationMs`, errors, raw action/expected, but no AI response/thought fields at `midscene_run/summary/test-results-20260518-172417.json:70-130`.
- Summary HTML displays the Midscene report file path at `scripts/lib/html-report.js:150`.
- `renderStepDetails` currently renders prompt and errors but no AI response/thought/rawResponse/usage at `scripts/lib/html-report.js:222-235`.

### Existing Generated Report Structure

Inspected `midscene_run/report/testcases-20260518-172417.html` by extracting `midscene_web_dump` tags. The report contains multiple append-only per-task snapshots. Later snapshots for the same `execution.id` hold the completed task state.

Observed final `aiAct` planning task for SQ-81350:

- `task.type`: `Planning`
- `task.subType`: `Plan`
- `task.status`: `finished`
- `task.param.userInstruction`: full act prompt
- `task.log.rawResponse`: raw response containing escaped `__midscene_lt__thought__midscene_gt__...__midscene_lt__/thought__midscene_gt__` and `__midscene_lt__complete success="true"__midscene_gt__...`
- `task.output.thought`: parsed Chinese thought text
- `task.output.output`: final response text listing customer/contact/date/order number/team
- `task.usage`: `{ prompt_tokens, completion_tokens, total_tokens, cached_input, time_cost, model_name, model_description, slot, intent: "planning", request_id }`
- `task.reasoning_content`: absent in this run, because the configured provider did not return provider-level reasoning content

Observed final `aiAssert` insight task for SQ-81350:

- `task.type`: `Insight`
- `task.subType`: `Assert`
- `task.status`: `finished`
- `task.param.dataDemand`: assertion prompt
- `task.thought`: parsed assertion thought
- `task.output`: `true`
- `task.log.taskInfo.rawResponse`: raw XML extraction response with `thought`, `data-json`, and `errors` tags
- `task.log.taskInfo.formatResponse`: JSON string containing parsed thought and `{ StatementIsTruthy: true }`
- `task.log.taskInfo.usage`: token/time/model/request metadata
- `task.usage`: same usage normalized with `intent: "insight"`
- `task.reasoning_content`: absent in this run

Important parsing note: the report HTML includes bundled Midscene app JavaScript that itself contains string literals like `<script type="midscene_web_dump"`. When extracting report data from HTML, skip script occurrences whose body is not JSON and prefer script tags whose content starts with `{` and parses to a `ReportActionDump` with `executions`.

### Related Specs

- No `.trellis/spec/*.md` file was found or required for this research request.

## Caveats / Not Found

- No public `aiAct` direct return exposes the whole raw response object; direct `aiAct` returns only final output string. Full detail must come from dump/report/listener data.
- `aiAssert(..., { keepRawResponse: true })` exposes parsed `thought` and `message`, but not the full raw XML or usage directly; those remain in the task dump.
- `aiWaitFor` direct return is `void`; details must come from dump/report/listener data.
- `reasoning_content` is provider/model dependent. The inspected generated run used `gpt-5.4` through an OpenAI-compatible endpoint and did not include provider-level `reasoning_content` in final tasks, although the code paths support it.
- `persistExecutionDump` is currently not set in `scripts/lib/bridge-runner.js`; therefore existing report detail is embedded in HTML, not written as separate `*.execution.json` files.
- The custom `midscene_run/summary/test-results-*.json` files are repo-owned summaries and currently do not contain AI response fields. To include them, capture from `agent.addDumpUpdateListener`/`executionDump`, parse the Midscene report HTML after execution, set `persistExecutionDump: true`, or store direct `aiAct`/`aiAssert(... keepRawResponse)` returns where sufficient.
