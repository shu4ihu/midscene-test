#!/usr/bin/env node

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTestcases } from './lib/testcase-loader.js';
import { refineCases } from './lib/refine-steps.js';
import { buildDryRunResults, writeRunArtifacts } from './lib/html-report.js';
import { runCasesWithBridge } from './lib/bridge-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

async function main() {
  const startedAtDate = new Date();
  const runId = formatRunId(startedAtDate);
  const options = parseArgs(process.argv.slice(2));
  const testcasePath = path.resolve(projectRoot, options.source);
  const reportDir = path.resolve(projectRoot, options.reportDir || 'midscene_run/summary');

  const { metadata, cases } = await loadTestcases(testcasePath);
  const selectedCases = applyFilters(cases, options);
  const safeMode = !options.allowDestructive;
  const refinedCases = refineCases(selectedCases, {
    safeMode,
    baseContext: options.baseContext,
  });

  let results;
  let midsceneReportFile = '';
  const mode = options.dryRun ? 'dry-run' : options.url ? 'url' : 'current-tab';

  if (options.dryRun) {
    results = buildDryRunResults(refinedCases);
  } else {
    const bridgeResult = await runCasesWithBridge(refinedCases, {
      runId,
      metadata,
      url: options.url,
      safeMode,
      forceSameTabNavigation: options.forceSameTabNavigation,
      closeNewTabsAfterDisconnect: options.closeNewTabs,
    });
    results = bridgeResult.results;
    midsceneReportFile = bridgeResult.midsceneReportFile;
  }

  const endedAtDate = new Date();
  const runData = {
    runId,
    mode,
    safeMode,
    startedAt: startedAtDate.toISOString(),
    endedAt: endedAtDate.toISOString(),
    durationMs: endedAtDate.getTime() - startedAtDate.getTime(),
    metadata,
    source: {
      testcasePath,
      totalCases: cases.length,
      selectedCases: selectedCases.length,
    },
    options: sanitizeOptions(options),
    modelSummary: getModelSummary(),
    midsceneReportFile,
    results,
  };

  const artifacts = await writeRunArtifacts(runData, reportDir);

  console.log(`Run ID: ${runId}`);
  console.log(`Mode: ${mode}`);
  console.log(`Cases: ${selectedCases.length}/${cases.length}`);
  console.log(`Results JSON: ${artifacts.resultPath}`);
  console.log(`Summary HTML: ${artifacts.htmlPath}`);
  if (midsceneReportFile) {
    console.log(`Midscene report: ${midsceneReportFile}`);
  }
}

function parseArgs(args) {
  const options = {
    dryRun: false,
    currentTab: false,
    url: '',
    caseId: '',
    limit: 0,
    source: 'example/json/testcases.json',
    reportDir: '',
    allowDestructive: false,
    closeNewTabs: false,
    forceSameTabNavigation: true,
    baseContext: '',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--current-tab') {
      options.currentTab = true;
    } else if (arg === '--url') {
      options.url = requireValue(args, index, arg);
      index += 1;
    } else if (arg === '--case') {
      options.caseId = requireValue(args, index, arg);
      index += 1;
    } else if (arg === '--limit') {
      options.limit = Number.parseInt(requireValue(args, index, arg), 10);
      index += 1;
    } else if (arg === '--source') {
      options.source = requireValue(args, index, arg);
      index += 1;
    } else if (arg === '--report-dir') {
      options.reportDir = requireValue(args, index, arg);
      index += 1;
    } else if (arg === '--allow-destructive') {
      options.allowDestructive = true;
    } else if (arg === '--close-new-tabs') {
      options.closeNewTabs = true;
    } else if (arg === '--force-same-tab-navigation') {
      options.forceSameTabNavigation = parseBoolean(requireValue(args, index, arg), arg);
      index += 1;
    } else if (arg === '--base-context') {
      options.baseContext = requireValue(args, index, arg);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.dryRun && !options.url) {
    options.currentTab = true;
  }

  if (options.url && options.currentTab) {
    throw new Error('Use either --url or --current-tab, not both.');
  }

  if (options.limit < 0 || Number.isNaN(options.limit)) {
    throw new Error('--limit must be a positive integer.');
  }

  return options;
}

function applyFilters(cases, options) {
  let selectedCases = cases;

  if (options.caseId) {
    selectedCases = selectedCases.filter((testCase) => testCase.externalId === options.caseId);
    if (!selectedCases.length) {
      throw new Error(`No testcase found for --case ${options.caseId}`);
    }
  }

  if (options.limit > 0) {
    selectedCases = selectedCases.slice(0, options.limit);
  }

  return selectedCases;
}

function requireValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseBoolean(value, flag) {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${flag} must be true or false.`);
}

function sanitizeOptions(options) {
  return {
    dryRun: options.dryRun,
    currentTab: options.currentTab,
    url: options.url ? '[provided]' : '',
    caseId: options.caseId,
    limit: options.limit,
    source: options.source,
    reportDir: options.reportDir,
    allowDestructive: options.allowDestructive,
    closeNewTabs: options.closeNewTabs,
    forceSameTabNavigation: options.forceSameTabNavigation,
    baseContext: options.baseContext,
  };
}

function getModelSummary() {
  return {
    MIDSCENE_MODEL_NAME: process.env.MIDSCENE_MODEL_NAME,
    MIDSCENE_MODEL_BASE_URL: process.env.MIDSCENE_MODEL_BASE_URL,
    MIDSCENE_MODEL_FAMILY: process.env.MIDSCENE_MODEL_FAMILY,
  };
}

function formatRunId(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function printHelp() {
  console.log(`Usage: node scripts/run-testcases.js [options]

Options:
  --dry-run                              Parse, refine, and report without browser execution
  --current-tab                          Connect the current active Chrome tab (default for real runs)
  --url <url>                            Open and connect a new Chrome tab with the URL
  --case <external_id>                   Run only one testcase by external_id
  --limit <n>                            Run only the first n selected cases
  --source <path>                        Testcase JSON path, default example/json/testcases.json
  --report-dir <dir>                     Report output directory, default midscene_run/summary
  --allow-destructive                    Execute submit/close/status-changing steps
  --close-new-tabs                       Close bridge-created tabs after disconnect
  --force-same-tab-navigation true|false Control Bridge new-tab interception, default true
  --base-context <text>                  Add business context to AI prompts
  --help                                 Show this help
`);
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
