import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STATUSES = ['passed', 'failed', 'blocked', 'error', 'skipped'];

export async function writeRunArtifacts(runData, reportDir) {
  await mkdir(reportDir, { recursive: true });

  const resultPath = path.join(reportDir, `test-results-${runData.runId}.json`);
  const htmlPath = path.join(reportDir, `test-summary-${runData.runId}.html`);

  await writeFile(resultPath, `${JSON.stringify(runData, null, 2)}\n`, 'utf8');
  await writeFile(htmlPath, buildHtmlReport(runData), 'utf8');

  return { resultPath, htmlPath };
}

export function buildDryRunResults(refinedCases) {
  return refinedCases.map((testCase) => {
    const steps = testCase.refinedSteps.map((step) => buildDryRunStep(step, testCase));
    const firstSkipped = steps.find((step) => step.failureType === 'destructive-skipped');

    return {
      externalId: testCase.externalId,
      name: testCase.name,
      suiteId: testCase.suiteId,
      suitePath: testCase.suitePath,
      importanceLabel: testCase.importanceLabel,
      status: 'skipped',
      durationMs: 0,
      rawStepCount: testCase.rawSteps.length,
      refinedStepCount: testCase.refinedSteps.length,
      missingPreconditions: testCase.missingPreconditions,
      ...pickCaseDryRunFailure(firstSkipped),
      error: null,
      steps,
      rawSteps: testCase.rawSteps,
      preconditionsText: testCase.preconditionsText,
    };
  });
}

function buildDryRunStep(step, testCase) {
  const rawStep = testCase.rawSteps.find((item) => item.stepNumber === String(step.sourceStepNumber));
  const failureType = step.destructive ? 'destructive-skipped' : 'dry-run-skipped';
  const failureReason = step.destructive
    ? 'dry-run：未执行；该步骤可能改变业务数据。'
    : 'dry-run：未执行，仅生成解析、细化和报告结果。';

  return {
    type: step.type,
    sourceStepNumber: step.sourceStepNumber,
    prompt: step.prompt,
    expected: step.expected ?? '',
    destructive: Boolean(step.destructive),
    status: 'skipped',
    durationMs: 0,
    rawAction: rawStep?.actionText ?? '',
    rawExpected: rawStep?.expectedText ?? '',
    aiDetails: [],
    failureType,
    failureReason,
    failedStepNumber: step.sourceStepNumber,
    failedAction: rawStep?.actionText ?? '',
    failedExpected: rawStep?.expectedText ?? step.expected ?? '',
    errorName: '',
    errorMessage: '',
    errorStack: '',
    error: failureReason,
  };
}

function pickCaseDryRunFailure(firstSkipped) {
  if (!firstSkipped) {
    return {
      ...emptyFailureFields(),
      failureType: 'dry-run-skipped',
      failureReason: 'dry-run 模式不会真实执行用例。',
    };
  }

  return {
    failureType: firstSkipped.failureType,
    failureReason: 'dry-run 模式不会真实执行用例。',
    failedStepNumber: firstSkipped.failedStepNumber,
    failedAction: firstSkipped.failedAction,
    failedExpected: firstSkipped.failedExpected,
    errorName: '',
    errorMessage: '',
    errorStack: '',
  };
}

function buildHtmlReport(runData) {
  const stats = calculateStats(runData.results);
  const metadata = runData.metadata;
  const filters = metadata.filters ?? {};
  const project = metadata.project ?? {};

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Midscene 测试执行汇总 ${escapeHtml(runData.runId)}</title>
<style>
:root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; background: #f6f7fb; color: #1f2937; }
main { max-width: 1320px; margin: 0 auto; padding: 32px 20px 48px; }
h1 { margin: 0 0 8px; font-size: 28px; }
h2 { margin-top: 32px; font-size: 20px; }
h3 { margin: 0; font-size: 18px; }
a { color: #2563eb; text-decoration: none; }
a:hover { text-decoration: underline; }
.card, .case-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 18px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.stat { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px; }
.stat b { display: block; font-size: 24px; margin-top: 6px; }
.meta { display: grid; grid-template-columns: 180px 1fr; gap: 8px 16px; }
.case-list { display: grid; gap: 16px; }
.case-header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; border-bottom: 1px solid #e5e7eb; padding-bottom: 14px; margin-bottom: 14px; }
.case-title { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.case-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.step-list { display: grid; gap: 12px; margin-top: 12px; }
.step-card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px; background: #f9fafb; }
.step-head { display: flex; gap: 10px; justify-content: space-between; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.step-title { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 6px 14px; margin: 10px 0; }
.kv span { color: #6b7280; font-size: 12px; }
.kv b { display: block; color: #1f2937; font-size: 13px; overflow-wrap: anywhere; }
.status { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.passed { background: #dcfce7; color: #166534; }
.failed { background: #fee2e2; color: #991b1b; }
.blocked { background: #fef3c7; color: #92400e; }
.error { background: #f3e8ff; color: #6b21a8; }
.skipped { background: #e5e7eb; color: #374151; }
.tag { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #eef2ff; color: #3730a3; font-size: 12px; }
.button-link { display: inline-block; border: 1px solid #bfdbfe; background: #eff6ff; color: #1d4ed8; border-radius: 8px; padding: 6px 10px; font-size: 13px; }
details { margin: 8px 0; }
summary { cursor: pointer; color: #2563eb; }
pre { white-space: pre-wrap; word-break: break-word; background: #111827; color: #f9fafb; padding: 12px; border-radius: 8px; overflow: auto; max-height: 520px; }
.ai-grid { display: grid; gap: 8px; }
.ai-card { border: 1px solid #dbeafe; border-radius: 10px; padding: 12px; background: #f8fbff; }
.ai-card h4 { margin: 0 0 8px; font-size: 14px; }
.failure { color: #991b1b; font-weight: 600; }
.small { color: #6b7280; font-size: 12px; }
.empty { color: #9ca3af; font-style: italic; }
</style>
</head>
<body>
<main>
  <h1>Midscene 测试执行汇总</h1>
  <p class="small">Run ID: ${escapeHtml(runData.runId)}</p>

  <section class="card">
    <h2>运行概览</h2>
    <div class="meta">
      <span>项目</span><b>${escapeHtml(project.name ?? '')}</b>
      <span>测试计划</span><b>${escapeHtml(filters.test_plan ?? '')}</b>
      <span>Build</span><b>${escapeHtml(filters.build ?? '')}</b>
      <span>Keyword</span><b>${escapeHtml(filters.keyword ?? '')}</b>
      <span>导出时间</span><b>${escapeHtml(metadata.exportTime ?? '')}</b>
      <span>开始时间</span><b>${escapeHtml(runData.startedAt)}</b>
      <span>结束时间</span><b>${escapeHtml(runData.endedAt)}</b>
      <span>总耗时</span><b>${formatDuration(runData.durationMs)}</b>
      <span>执行模式</span><b>${escapeHtml(runData.mode)}</b>
      <span>安全模式</span><b>${runData.safeMode ? '开启' : '关闭'}</b>
      <span>Midscene 报告</span><b>${renderReportLink(runData.midsceneReportFile)}</b>
      <span>模型配置</span><b>${escapeHtml(formatModelSummary(runData.modelSummary))}</b>
    </div>
  </section>

  <h2>统计</h2>
  <section class="grid">
    ${statCard('总用例', stats.total)}
    ${statCard('总步骤', stats.totalSteps)}
    ${statCard('Passed', stats.passed)}
    ${statCard('Failed', stats.failed)}
    ${statCard('Blocked', stats.blocked)}
    ${statCard('Error', stats.error)}
    ${statCard('Skipped', stats.skipped)}
    ${statCard('Pass Rate', `${stats.passRate}%`)}
  </section>

  <h2>失败原因摘要</h2>
  <section class="card">
    ${renderFailureSummary(runData.results)}
  </section>

  <h2>用例明细</h2>
  <section class="case-list">
    ${runData.results.map((result, index) => renderCaseCard(result, index, runData.midsceneReportFile)).join('\n')}
  </section>
</main>
</body>
</html>`;
}

function renderCaseCard(result, index, midsceneReportFile) {
  return `<article class="case-card">
    <div class="case-header">
      <div>
        <div class="case-title">
          <span class="tag">#${index + 1}</span>
          <h3>${escapeHtml(result.externalId)} ${escapeHtml(result.name)}</h3>
          ${statusBadge(result.status)}
        </div>
        <div class="small">Suite: ${escapeHtml(result.suiteId)}${result.importanceLabel ? ` · ${escapeHtml(result.importanceLabel)}` : ''}</div>
      </div>
      <div class="case-actions">
        ${renderReportLink(midsceneReportFile, '打开 Midscene 原生报告')}
      </div>
    </div>
    <div class="kv">
      <div><span>原始/细化步骤</span><b>${escapeHtml(result.rawStepCount)} / ${escapeHtml(result.refinedStepCount)}</b></div>
      <div><span>耗时</span><b>${escapeHtml(formatDuration(result.durationMs))}</b></div>
      <div><span>失败步骤</span><b>${escapeHtml(result.failedStepNumber || '无')}</b></div>
      <div><span>失败类型</span><b>${escapeHtml(result.failureType || '无')}</b></div>
    </div>
    ${renderCaseFailureSummary(result)}
    ${result.missingPreconditions?.length ? `<details><summary>前置条件/数据要求</summary><pre>${escapeHtml(result.missingPreconditions.join('\n'))}</pre></details>` : ''}
    <details><summary>原始步骤</summary><pre>${escapeHtml(formatRawSteps(result.rawSteps ?? []))}</pre></details>
    <details open><summary>执行步骤与 AI 详情</summary>${renderStepDetails(result.steps ?? [])}</details>
    ${result.errorStack ? `<details><summary>Case error stack</summary><pre>${escapeHtml(result.errorStack)}</pre></details>` : ''}
  </article>`;
}

function renderCaseFailureSummary(result) {
  if (!result.failureType && !result.failureReason && result.status === 'passed') {
    return '<p class="small">失败摘要：无</p>';
  }

  return `<div>
    ${result.failureType ? `<div class="failure">${escapeHtml(result.failureType)}</div>` : ''}
    ${result.failureReason ? `<div>${escapeHtml(result.failureReason)}</div>` : ''}
    ${result.failedStepNumber ? `<div class="small">step: ${escapeHtml(result.failedStepNumber)}</div>` : ''}
    ${result.errorMessage ? `<details><summary>Case error message</summary><pre>${escapeHtml(result.errorMessage)}</pre></details>` : ''}
  </div>`;
}

function renderStepDetails(steps) {
  if (!steps.length) {
    return '<p class="small">无步骤记录</p>';
  }

  return `<div class="step-list">${steps.map((step, index) => `<section class="step-card">
    <div class="step-head">
      <div class="step-title">
        <b>${index + 1}. ${escapeHtml(step.type)}</b>
        ${statusBadge(step.status)}
        <span class="small">source step: ${escapeHtml(step.sourceStepNumber)}</span>
      </div>
      <span class="small">${escapeHtml(formatDuration(step.durationMs))}</span>
    </div>
    ${step.destructive ? '<p class="small">可能改变业务数据</p>' : ''}
    ${step.failureType ? `<p class="failure">${escapeHtml(step.failureType)}：${escapeHtml(step.failureReason)}</p>` : ''}
    ${step.rawAction || step.rawExpected ? `<details><summary>原始动作/预期</summary><pre>${escapeHtml(formatActionExpected(step.rawAction, step.rawExpected))}</pre></details>` : ''}
    <details><summary>细化 prompt</summary><pre>${escapeHtml(step.prompt ?? '')}</pre></details>
    ${renderAiDetails(step.aiDetails ?? [])}
    ${step.errorMessage ? `<details><summary>error message</summary><pre>${escapeHtml(step.errorMessage)}</pre></details>` : ''}
    ${step.errorStack ? `<details><summary>error stack</summary><pre>${escapeHtml(step.errorStack)}</pre></details>` : ''}
  </section>`).join('\n')}</div>`;
}

function renderAiDetails(aiDetails) {
  if (!aiDetails.length) {
    return '<details><summary>AI 详情</summary><p class="empty">该步骤没有捕获到 AI 响应。</p></details>';
  }

  return `<details><summary>AI 详情 (${aiDetails.length})</summary>
    <div class="ai-grid">
      ${aiDetails.map((detail, index) => renderAiDetail(detail, index)).join('\n')}
    </div>
  </details>`;
}

function renderAiDetail(detail, index) {
  return `<section class="ai-card">
    <h4>${index + 1}. ${escapeHtml([detail.type, detail.subType].filter(Boolean).join(' / ') || 'AI Task')} ${detail.status ? statusBadge(detail.status) : ''}</h4>
    <div class="kv">
      <div><span>Task ID</span><b>${escapeHtml(detail.id || '无')}</b></div>
      <div><span>Request ID</span><b>${escapeHtml(detail.usage?.request_id || '无')}</b></div>
      <div><span>Model</span><b>${escapeHtml(detail.usage?.model_name || '无')}</b></div>
      <div><span>Intent</span><b>${escapeHtml(detail.usage?.intent || '无')}</b></div>
    </div>
    ${renderTextBlock('AI task prompt', detail.prompt)}
    ${renderTextBlock('思考 / Thought', detail.thought)}
    ${renderTextBlock('响应 / Output', detail.output)}
    ${renderTextBlock('Provider reasoning content', detail.reasoningContent || '模型未返回 provider-level reasoning content。')}
    ${renderTextBlock('Raw response', detail.rawResponse)}
    ${renderTextBlock('Formatted response', detail.formatResponse)}
    ${renderTextBlock('AI task error message', detail.errorMessage)}
    ${renderTextBlock('AI task error stack', detail.errorStack)}
    ${detail.usage ? renderTextBlock('Usage', JSON.stringify(detail.usage, null, 2)) : ''}
  </section>`;
}

function renderTextBlock(title, value) {
  if (!value) {
    return '';
  }

  return `<details><summary>${escapeHtml(title)}</summary><pre>${escapeHtml(value)}</pre></details>`;
}

function renderFailureSummary(results) {
  const failures = collectFailures(results);

  if (!failures.length) {
    return '<p>无失败、阻塞、错误或跳过记录。</p>';
  }

  const grouped = Map.groupBy
    ? Map.groupBy(failures, (failure) => failure.failureType || 'unknown')
    : groupByFailureType(failures);

  return [...grouped.entries()].map(([failureType, items]) => `<details open>
    <summary><b>${escapeHtml(failureType)}</b> (${items.length})</summary>
    <ul>
      ${items.map((item) => `<li>
        <b>${escapeHtml(item.externalId)}</b> ${escapeHtml(item.name)}
        ${item.sourceStepNumber ? `<span class="small">step ${escapeHtml(item.sourceStepNumber)}</span>` : ''}
        <div>${escapeHtml(item.failureReason)}</div>
        ${item.errorMessage ? `<div class="small">${escapeHtml(item.errorMessage)}</div>` : ''}
      </li>`).join('\n')}
    </ul>
  </details>`).join('\n');
}

function collectFailures(results) {
  return results.flatMap((result) => {
    const items = [];

    if (result.status !== 'passed' && (result.failureType || result.failureReason || result.errorMessage)) {
      items.push({
        externalId: result.externalId,
        name: result.name,
        sourceStepNumber: result.failedStepNumber,
        failureType: result.failureType || result.status,
        failureReason: result.failureReason || result.errorMessage || result.status,
        errorMessage: result.errorMessage,
      });
    }

    for (const step of result.steps ?? []) {
      if (step.status !== 'passed' && (step.failureType || step.failureReason || step.errorMessage)) {
        items.push({
          externalId: result.externalId,
          name: result.name,
          sourceStepNumber: step.sourceStepNumber,
          failureType: step.failureType || step.status,
          failureReason: step.failureReason || step.errorMessage || step.status,
          errorMessage: step.errorMessage,
        });
      }
    }

    return items;
  });
}

function calculateStats(results) {
  const stats = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  let totalSteps = 0;

  for (const result of results) {
    stats[result.status] = (stats[result.status] ?? 0) + 1;
    totalSteps += result.steps?.length ?? result.refinedStepCount ?? 0;
  }

  const total = results.length;
  const passRate = total ? Math.round((stats.passed / total) * 10000) / 100 : 0;

  return { ...stats, total, totalSteps, passRate };
}

function groupByFailureType(failures) {
  const grouped = new Map();

  for (const failure of failures) {
    const key = failure.failureType || 'unknown';
    const values = grouped.get(key) ?? [];
    values.push(failure);
    grouped.set(key, values);
  }

  return grouped;
}

function statCard(label, value) {
  return `<div class="stat"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
}

function statusBadge(status) {
  const normalized = statusBadgeClass(status);
  return `<span class="status ${normalized}">${escapeHtml(status)}</span>`;
}

function statusBadgeClass(status) {
  if (STATUSES.includes(status)) {
    return status;
  }

  if (status === 'finished') {
    return 'passed';
  }

  return 'error';
}

function renderReportLink(reportFile, label = '打开报告') {
  if (!reportFile) {
    return '<span class="small">无</span>';
  }

  const href = toFileHref(reportFile);
  return `<a class="button-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a> <span class="small">${escapeHtml(reportFile)}</span>`;
}

function toFileHref(filePath) {
  if (/^https?:\/\//i.test(filePath) || /^file:\/\//i.test(filePath)) {
    return filePath;
  }

  const normalized = filePath.replaceAll('\\', '/');
  if (/^[a-z]:\//i.test(normalized)) {
    return encodeURI(`file:///${normalized}`);
  }

  return encodeURI(normalized);
}

function formatRawSteps(rawSteps) {
  return rawSteps.map((step) => [
    `步骤 ${step.stepNumber}`,
    step.actionText ? `动作：${step.actionText}` : '',
    step.expectedText ? `预期：${step.expectedText}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

function formatActionExpected(action, expected) {
  return [
    action ? `动作：${action}` : '',
    expected ? `预期：${expected}` : '',
  ].filter(Boolean).join('\n');
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return '0ms';
  }

  if (ms < 1000) {
    return `${ms}ms`;
  }

  return `${(ms / 1000).toFixed(2)}s`;
}

function formatModelSummary(summary = {}) {
  return Object.entries(summary)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ') || '未配置摘要';
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
