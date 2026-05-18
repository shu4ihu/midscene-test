import { readFile } from 'node:fs/promises';
import { AgentOverChromeBridge } from '@midscene/web/bridge-mode';

export async function runCasesWithBridge(refinedCases, options) {
  const agent = new AgentOverChromeBridge({
    allowRemoteAccess: false,
    closeNewTabsAfterDisconnect: options.closeNewTabsAfterDisconnect,
    generateReport: true,
    reportFileName: `testcases-${options.runId}`,
    groupName: `${options.metadata.project.name ?? 'Midscene'} UI 用例执行`,
    groupDescription: buildGroupDescription(options),
    outputFormat: 'single-html',
    reportAttributes: {
      runId: options.runId,
      source: options.metadata.sourceFile,
      mode: options.url ? 'url' : 'current-tab',
      safeMode: String(options.safeMode),
    },
  });

  const aiDumpCollector = createAiDumpCollector(agent);
  const results = [];
  let reportFile = '';

  try {
    if (options.url) {
      await agent.connectNewTabWithUrl(options.url, {
        forceSameTabNavigation: options.forceSameTabNavigation,
      });
    } else {
      await agent.connectCurrentTab({
        forceSameTabNavigation: options.forceSameTabNavigation,
      });
    }

    for (const testCase of refinedCases) {
      results.push(await runSingleCase(agent, testCase, options, aiDumpCollector));
    }

    reportFile = agent.reportFile ?? '';
  } catch (error) {
    if (!results.length) {
      results.push(...refinedCases.map((testCase) => buildInfrastructureErrorResult(testCase, error, 'bridge-connect')));
    } else {
      results.push(buildInfrastructureSummaryResult(error));
    }
  } finally {
    reportFile = reportFile || agent.reportFile || '';
    await agent.destroy(options.closeNewTabsAfterDisconnect).catch(() => {});
    await backfillAiDetailsFromReport(results, reportFile);
  }

  return { results, midsceneReportFile: reportFile };
}

async function runSingleCase(agent, testCase, options, aiDumpCollector) {
  const start = Date.now();
  const stepResults = [];
  let status = 'passed';
  let failure = emptyFailureFields();

  await safeRecord(agent, `Start ${testCase.externalId} ${testCase.name}`, {
    content: buildCaseRecord(testCase),
  });

  for (const step of testCase.refinedSteps) {
    const stepStart = Date.now();
    const stepResult = buildStepResult(step, testCase);
    let checkpoint = aiDumpCollector.checkpoint();

    try {
      if (step.destructive && options.safeMode !== false) {
        const skippedFailure = buildStepFailure({
          testCase,
          step,
          status: 'skipped',
          failureType: 'destructive-skipped',
          failureReason: step.blockedReason || 'safe mode 默认跳过可能改变业务数据的动作',
        });
        Object.assign(stepResult, skippedFailure);
        if (status === 'passed') {
          status = 'skipped';
          failure = pickCaseFailure(skippedFailure);
        }
        await safeRecord(agent, `Skipped ${testCase.externalId} step ${step.sourceStepNumber}`, {
          content: `${stepResult.failureReason}\n\n${step.prompt}`,
        });
        continue;
      }

      checkpoint = aiDumpCollector.checkpoint();
      await executeStep(agent, testCase, step);
      stepResult.aiDetails = aiDumpCollector.collectSince(checkpoint);
    } catch (stepError) {
      stepResult.aiDetails = aiDumpCollector.collectSince(checkpoint);
      const failedStatus = step.type === 'manual-note' ? 'blocked' : 'failed';
      const stepFailure = buildStepFailure({
        testCase,
        step,
        status: failedStatus,
        failureType: classifyStepFailure(stepError, step),
        failureReason: buildFailureReason(stepError, step),
        error: stepError,
      });
      Object.assign(stepResult, stepFailure);
      status = failedStatus;
      failure = pickCaseFailure(stepFailure);
      await safeRecord(agent, `Failed ${testCase.externalId} step ${step.sourceStepNumber}`, {
        content: `${stepResult.failureReason}\n${stepResult.errorMessage}\n\n${step.prompt}`,
      });
      break;
    } finally {
      stepResult.durationMs = Date.now() - stepStart;
      stepResults.push(stepResult);
    }
  }

  const result = {
    externalId: testCase.externalId,
    name: testCase.name,
    suiteId: testCase.suiteId,
    suitePath: testCase.suitePath,
    importanceLabel: testCase.importanceLabel,
    status,
    durationMs: Date.now() - start,
    rawStepCount: testCase.rawSteps.length,
    refinedStepCount: testCase.refinedSteps.length,
    missingPreconditions: testCase.missingPreconditions,
    ...failure,
    error: failure.errorMessage ? {
      name: failure.errorName,
      message: failure.errorMessage,
      stack: failure.errorStack,
    } : null,
    steps: stepResults,
    rawSteps: testCase.rawSteps,
    preconditionsText: testCase.preconditionsText,
  };

  await safeRecord(agent, `End ${testCase.externalId} ${status}`, {
    content: [
      `status: ${status}`,
      result.failureType ? `failureType: ${result.failureType}` : '',
      result.failureReason ? `failureReason: ${result.failureReason}` : '',
      `durationMs: ${result.durationMs}`,
    ].filter(Boolean).join('\n'),
  });

  return result;
}

async function executeStep(agent, testCase, step) {
  if (step.type === 'record') {
    await safeRecord(agent, `${testCase.externalId} step ${step.sourceStepNumber}`, { content: step.prompt });
    return;
  }

  if (step.type === 'manual-note') {
    await safeRecord(agent, `${testCase.externalId} note`, { content: step.prompt });
    return;
  }

  if (step.type === 'act') {
    await agent.aiAct(step.prompt);
    return;
  }

  if (step.type === 'assert') {
    await agent.aiAssert(step.prompt);
    return;
  }

  if (step.type === 'wait') {
    await agent.aiWaitFor(step.prompt);
    return;
  }

  throw new Error(`Unsupported refined step type: ${step.type}`);
}

async function safeRecord(agent, title, payload) {
  if (typeof agent.recordToReport !== 'function') {
    return;
  }

  await agent.recordToReport(title, payload).catch(() => {});
}

function createAiDumpCollector(agent) {
  const detailsByKey = new Map();
  const detailOrder = [];

  const rememberDetail = (task) => {
    const detail = extractAiDetail(task);
    if (!detail) {
      return;
    }

    const key = detail.id || `${detail.type}:${detail.subType}:${detailOrder.length}`;
    if (!detailsByKey.has(key)) {
      detailOrder.push(key);
    }
    detailsByKey.set(key, detail);
  };

  const listener = (_dump, executionDump) => {
    for (const execution of executionDump?.executions ?? []) {
      for (const task of execution.tasks ?? []) {
        rememberDetail(task);
      }
    }
  };

  if (typeof agent.addDumpUpdateListener === 'function') {
    agent.addDumpUpdateListener(listener);
  } else {
    const existingListener = agent.onDumpUpdate;
    agent.onDumpUpdate = (dump, executionDump) => {
      existingListener?.(dump, executionDump);
      listener(dump, executionDump);
    };
  }

  return {
    checkpoint() {
      return detailOrder.length;
    },
    collectSince(index) {
      return detailOrder.slice(index).map((key) => detailsByKey.get(key)).filter(Boolean);
    },
  };
}

function extractAiDetail(task) {
  if (!isAiTask(task)) {
    return null;
  }

  const taskInfo = task.log?.taskInfo ?? {};
  const output = normalizeOutput(task.output);
  const usage = task.usage ?? taskInfo.usage ?? null;

  return pruneEmptyFields({
    id: task.taskId ?? task.id ?? task.index ?? '',
    type: task.type ?? '',
    subType: task.subType ?? '',
    status: task.status ?? '',
    prompt: formatUnknownValue(task.param?.userInstruction ?? task.param?.dataDemand ?? task.param?.prompt),
    thought: output.thought || task.thought || '',
    output: output.output || formatUnknownValue(task.output),
    rawResponse: task.log?.rawResponse ?? taskInfo.rawResponse ?? '',
    formatResponse: taskInfo.formatResponse ?? '',
    reasoningContent: task.reasoning_content ?? taskInfo.reasoning_content ?? '',
    usage,
    errorMessage: task.errorMessage ?? '',
    errorStack: task.errorStack ?? '',
  });
}

function isAiTask(task) {
  if (!task || !['finished', 'failed'].includes(task.status)) {
    return false;
  }

  if (task.type === 'Planning') {
    return true;
  }

  return task.type === 'Insight' && ['Assert', 'WaitFor'].includes(task.subType);
}

function normalizeOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { thought: '', output: formatUnknownValue(output) };
  }

  return {
    thought: formatUnknownValue(output.thought),
    output: formatUnknownValue(output.output ?? output),
  };
}

function formatUnknownValue(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function pruneEmptyFields(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (item === null || item === undefined || item === '') {
      return false;
    }
    if (Array.isArray(item)) {
      return item.length > 0;
    }
    if (typeof item === 'object') {
      return Object.keys(item).length > 0;
    }
    return true;
  }));
}

async function backfillAiDetailsFromReport(results, reportFile) {
  if (!reportFile) {
    return;
  }

  const aiDetails = await readAiDetailsFromReport(reportFile);
  if (!aiDetails.length) {
    return;
  }

  let cursor = 0;
  for (const result of results) {
    for (const step of result.steps ?? []) {
      if (!isExecutableAiStep(step) || step.aiDetails?.length) {
        continue;
      }

      const expectedSubType = expectedAiSubType(step.type);
      const stepDetails = collectMatchingAiDetails(aiDetails, cursor, expectedSubType, step.prompt);

      if (stepDetails.length) {
        step.aiDetails = stepDetails;
        cursor = aiDetails.indexOf(stepDetails.at(-1)) + 1;
      }
    }
  }
}

async function readAiDetailsFromReport(reportFile) {
  let html = '';
  try {
    html = await readFile(reportFile, 'utf8');
  } catch {
    return [];
  }

  const detailsByKey = new Map();
  const detailOrder = [];
  const scriptPattern = /<script type="midscene_web_dump"[^>]*>([\s\S]*?)<\/script>/g;

  for (const match of html.matchAll(scriptPattern)) {
    const body = unescapeMidsceneScriptContent(match[1].trim());
    if (!body.startsWith('{')) {
      continue;
    }

    let dump;
    try {
      dump = JSON.parse(body);
    } catch {
      continue;
    }

    for (const execution of dump.executions ?? []) {
      for (const task of execution.tasks ?? []) {
        const detail = extractAiDetail(task);
        if (!detail) {
          continue;
        }

        const key = detail.id || `${detail.type}:${detail.subType}:${detailOrder.length}`;
        if (!detailsByKey.has(key)) {
          detailOrder.push(key);
        }
        detailsByKey.set(key, detail);
      }
    }
  }

  return detailOrder.map((key) => detailsByKey.get(key)).filter(Boolean);
}

function unescapeMidsceneScriptContent(content) {
  return content
    .replaceAll('__midscene_lt__', '<')
    .replaceAll('__midscene_gt__', '>');
}

function isExecutableAiStep(step) {
  return ['act', 'assert', 'wait'].includes(step.type);
}

function expectedAiSubType(stepType) {
  if (stepType === 'act') {
    return 'Plan';
  }
  if (stepType === 'assert') {
    return 'Assert';
  }
  if (stepType === 'wait') {
    return 'WaitFor';
  }
  return '';
}

function collectMatchingAiDetails(aiDetails, cursor, expectedSubType, prompt) {
  const firstPromptMatchIndex = aiDetails.findIndex((detail, index) => (
    index >= cursor && matchesStepDetail(detail, expectedSubType) && detailMatchesPrompt(detail, prompt)
  ));

  if (firstPromptMatchIndex !== -1) {
    const promptMatchedDetails = [];
    for (let index = firstPromptMatchIndex; index < aiDetails.length; index += 1) {
      const detail = aiDetails[index];
      if (!matchesStepDetail(detail, expectedSubType) || !detailMatchesPrompt(detail, prompt)) {
        break;
      }
      promptMatchedDetails.push(detail);
    }
    return promptMatchedDetails;
  }

  const fallbackDetail = aiDetails.find((detail, index) => index >= cursor && matchesStepDetail(detail, expectedSubType));
  return fallbackDetail ? [fallbackDetail] : [];
}

function matchesStepDetail(detail, expectedSubType) {
  if (!expectedSubType) {
    return false;
  }
  return detail.subType === expectedSubType || (expectedSubType === 'Plan' && detail.type === 'Planning');
}

function detailMatchesPrompt(detail, prompt) {
  return Boolean(prompt && detail.prompt && normalizePromptText(detail.prompt) === normalizePromptText(prompt));
}

function normalizePromptText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function buildStepResult(step, testCase) {
  const rawStep = findRawStep(testCase, step.sourceStepNumber);

  return {
    type: step.type,
    sourceStepNumber: step.sourceStepNumber,
    prompt: step.prompt,
    expected: step.expected ?? '',
    destructive: Boolean(step.destructive),
    status: 'passed',
    durationMs: 0,
    rawAction: rawStep?.actionText ?? '',
    rawExpected: rawStep?.expectedText ?? '',
    aiDetails: [],
    ...emptyFailureFields(),
    error: null,
  };
}

function buildStepFailure({ testCase, step, status, failureType, failureReason, error = null }) {
  const rawStep = findRawStep(testCase, step.sourceStepNumber);
  const serialized = error ? serializeError(error) : null;

  return {
    status,
    failureType,
    failureReason,
    failedStepNumber: step.sourceStepNumber,
    failedAction: rawStep?.actionText ?? '',
    failedExpected: rawStep?.expectedText ?? step.expected ?? '',
    errorName: serialized?.name ?? '',
    errorMessage: serialized?.message ?? '',
    errorStack: serialized?.stack ?? '',
    error: serialized,
  };
}

function pickCaseFailure(stepFailure) {
  return {
    failureType: stepFailure.failureType,
    failureReason: stepFailure.failureReason,
    failedStepNumber: stepFailure.failedStepNumber,
    failedAction: stepFailure.failedAction,
    failedExpected: stepFailure.failedExpected,
    errorName: stepFailure.errorName,
    errorMessage: stepFailure.errorMessage,
    errorStack: stepFailure.errorStack,
  };
}

function buildInfrastructureErrorResult(testCase, error, failureType) {
  const serialized = serializeError(error);
  const failureReason = failureType === 'bridge-connect'
    ? 'Bridge 连接失败：请检查 Chrome、Midscene 扩展、当前标签页权限和端口占用。'
    : '执行基础设施异常。';

  return {
    externalId: testCase.externalId,
    name: testCase.name,
    suiteId: testCase.suiteId,
    suitePath: testCase.suitePath,
    importanceLabel: testCase.importanceLabel,
    status: 'error',
    durationMs: 0,
    rawStepCount: testCase.rawSteps.length,
    refinedStepCount: testCase.refinedSteps.length,
    missingPreconditions: testCase.missingPreconditions,
    failureType,
    failureReason,
    failedStepNumber: '',
    failedAction: '',
    failedExpected: '',
    errorName: serialized.name,
    errorMessage: serialized.message,
    errorStack: serialized.stack,
    error: serialized,
    steps: [],
    rawSteps: testCase.rawSteps,
    preconditionsText: testCase.preconditionsText,
  };
}

function buildInfrastructureSummaryResult(error) {
  const serialized = serializeError(error);
  return {
    externalId: '__infrastructure__',
    name: 'Bridge runner infrastructure error',
    suiteId: '',
    suitePath: '',
    importanceLabel: '',
    status: 'error',
    durationMs: 0,
    rawStepCount: 0,
    refinedStepCount: 0,
    missingPreconditions: [],
    failureType: classifyInfrastructureFailure(error),
    failureReason: '批量执行过程中发生基础设施异常，后续用例可能未执行。',
    failedStepNumber: '',
    failedAction: '',
    failedExpected: '',
    errorName: serialized.name,
    errorMessage: serialized.message,
    errorStack: serialized.stack,
    error: serialized,
    steps: [],
  };
}

function buildCaseRecord(testCase) {
  return [
    `用例：${testCase.externalId} ${testCase.name}`,
    testCase.suiteId ? `Suite ID：${testCase.suiteId}` : '',
    testCase.preconditionsText ? `前置条件：${testCase.preconditionsText}` : '',
    `原始步骤数：${testCase.rawSteps.length}`,
    `细化步骤数：${testCase.refinedSteps.length}`,
  ].filter(Boolean).join('\n');
}

function buildGroupDescription(options) {
  const filters = options.metadata.filters ?? {};
  return [
    filters.test_plan ? `测试计划：${filters.test_plan}` : '',
    filters.build ? `Build：${filters.build}` : '',
    filters.keyword ? `Keyword：${filters.keyword}` : '',
    options.metadata.exportTime ? `导出时间：${options.metadata.exportTime}` : '',
    `运行模式：${options.url ? 'url' : 'current-tab'}`,
  ].filter(Boolean).join('\n');
}

function classifyStepFailure(error, step) {
  const message = `${error?.name ?? ''} ${error?.message ?? ''} ${error?.stack ?? ''}`.toLowerCase();

  if (message.includes('timeout') || message.includes('timed out')) {
    return 'timeout';
  }

  if (message.includes('403') || message.includes('blocked') || message.includes('api') || message.includes('model')) {
    return 'ai-call';
  }

  if (step.type === 'assert') {
    return 'assertion-failed';
  }

  if (step.type === 'manual-note') {
    return 'precondition-missing';
  }

  return 'script-error';
}

function classifyInfrastructureFailure(error) {
  const message = `${error?.name ?? ''} ${error?.message ?? ''} ${error?.stack ?? ''}`.toLowerCase();

  if (message.includes('403') || message.includes('api') || message.includes('model')) {
    return 'ai-call';
  }

  if (message.includes('timeout') || message.includes('timed out')) {
    return 'timeout';
  }

  if (message.includes('bridge') || message.includes('connect') || message.includes('socket') || message.includes('extension')) {
    return 'bridge-connect';
  }

  return 'script-error';
}

function buildFailureReason(error, step) {
  if (step.type === 'assert') {
    return '页面状态不满足该步骤的预期断言。';
  }

  if (step.type === 'manual-note') {
    return step.blockedReason || '该步骤需要人工确认前置条件或测试数据。';
  }

  const type = classifyStepFailure(error, step);

  if (type === 'ai-call') {
    return 'AI 模型调用失败，请检查模型配置、API key、网关权限或限流。';
  }

  if (type === 'timeout') {
    return '步骤执行超时，可能是页面加载慢、目标元素未出现或 Bridge 响应超时。';
  }

  return '步骤执行异常，请查看错误 message 和 stack。';
}

function findRawStep(testCase, sourceStepNumber) {
  return testCase.rawSteps.find((rawStep) => rawStep.stepNumber === String(sourceStepNumber));
}

function emptyFailureFields() {
  return {
    failureType: '',
    failureReason: '',
    failedStepNumber: '',
    failedAction: '',
    failedExpected: '',
    errorName: '',
    errorMessage: '',
    errorStack: '',
  };
}

function serializeError(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    stack: error?.stack ?? '',
  };
}
