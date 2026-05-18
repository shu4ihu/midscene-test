import { readFile } from 'node:fs/promises';

const BLOCK_TAG_PATTERN = /<\/?(?:p|div|section|article|header|footer|main|aside|br|hr|li|ul|ol|tr|td|th|table|thead|tbody|h[1-6])\b[^>]*>/gi;

const HTML_ENTITIES = new Map([
  ['nbsp', ' '],
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['mdash', '—'],
  ['ndash', '–'],
  ['hellip', '…'],
]);

export async function loadTestcases(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const data = JSON.parse(raw);
  const cases = flattenTestcases(data);

  if (Number.isFinite(data.total_cases) && data.total_cases !== cases.length) {
    throw new Error(`testcases.json total_cases=${data.total_cases}, but flattened cases=${cases.length}`);
  }

  return {
    metadata: {
      project: data.project ?? {},
      filters: data.filters ?? {},
      exportTime: data.export_time ?? '',
      totalCases: data.total_cases ?? cases.length,
      sourceFile: filePath,
    },
    cases,
  };
}

export function flattenTestcases(data) {
  const suites = Array.isArray(data.test_suites) ? data.test_suites : [];

  return suites.flatMap((suite) => {
    const testCases = Array.isArray(suite.test_cases) ? suite.test_cases : [];

    return testCases.map((testCase) => ({
      suiteId: String(suite.suite_id ?? testCase.suite_id ?? ''),
      suitePath: cleanHtml(suite.suite_path ?? testCase.suite_path ?? ''),
      externalId: String(testCase.external_id ?? ''),
      name: String(testCase.name ?? ''),
      importanceLabel: String(testCase.importance_label ?? ''),
      executionTypeLabel: String(testCase.execution_type_label ?? ''),
      statusLabel: String(testCase.status_label ?? ''),
      preconditionsText: cleanHtml(testCase.preconditions ?? ''),
      rawSteps: normalizeSteps(testCase.steps),
    }));
  });
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) {
    return [];
  }

  return steps.map((step, index) => ({
    stepNumber: String(step.step_number ?? index + 1),
    actionText: cleanHtml(step.actions ?? ''),
    expectedText: cleanHtml(step.expected_results ?? ''),
    executionType: String(step.execution_type ?? ''),
  }));
}

export function cleanHtml(value) {
  return String(value ?? '')
    .replace(BLOCK_TAG_PATTERN, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, decodeEntity)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function decodeEntity(match, entity) {
  const normalized = entity.toLowerCase();

  if (normalized.startsWith('#x')) {
    const codePoint = Number.parseInt(normalized.slice(2), 16);
    return decodeCodePoint(match, codePoint);
  }

  if (normalized.startsWith('#')) {
    const codePoint = Number.parseInt(normalized.slice(1), 10);
    return decodeCodePoint(match, codePoint);
  }

  return HTML_ENTITIES.get(normalized) ?? match;
}

function decodeCodePoint(fallback, codePoint) {
  if (!Number.isFinite(codePoint)) {
    return fallback;
  }

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}
