const DESTRUCTIVE_KEYWORDS = [
  '提交',
  '保存',
  '删除',
  '移除',
  '关闭',
  '取消',
  '确认',
  '审核',
  '审批',
  '发布',
  '下架',
  '启用',
  '禁用',
  '新增',
  '创建',
  '编辑',
  '修改',
  '更新',
  '状态变为',
  '操作成功',
];

const DATA_REQUIREMENT_KEYWORDS = [
  '已关联',
  '满足',
  '加入',
  '权限',
  '状态为',
  '状态是',
  '存在',
  '角色',
  '账号',
  '用户',
  '团队',
  '组织',
  '审批状态',
];

const INTERACTION_KEYWORDS = [
  '不可复制',
  '可复制',
  '可查看',
  '可点击',
  '点击',
  '跳转',
  '下拉',
  '展开',
  '弹窗',
];

const PARENTHETICAL_NOTE_PATTERN = /[（(]([^（）()]*)[）)]/g;

export function refineCaseSteps(testCase, options = {}) {
  const refinedSteps = [];
  const missingPreconditions = detectMissingPreconditions(testCase);

  if (testCase.preconditionsText) {
    refinedSteps.push({
      type: 'manual-note',
      prompt: `用例前置条件：${testCase.preconditionsText}`,
      sourceStepNumber: 'precondition',
      destructive: false,
      blockedReason: missingPreconditions.length ? missingPreconditions.join('；') : '',
    });
  }

  for (const rawStep of testCase.rawSteps) {
    const expectedSplit = splitExpectedTextForInteractions(rawStep.expectedText);
    const stepContext = buildStepContext(testCase, rawStep, options.baseContext, expectedSplit);
    const destructive = isDestructiveStep(rawStep);

    refinedSteps.push({
      type: 'record',
      prompt: stepContext,
      sourceStepNumber: rawStep.stepNumber,
      destructive,
      blockedReason: '',
    });

    if (rawStep.actionText) {
      refinedSteps.push({
        type: 'act',
        prompt: buildActionPrompt(testCase, rawStep, options.baseContext, expectedSplit.staticExpectedText),
        sourceStepNumber: rawStep.stepNumber,
        destructive,
        blockedReason: destructive && options.safeMode !== false ? 'safe mode 默认跳过可能改变业务数据的动作' : '',
      });
    }

    if (rawStep.expectedText && expectedSplit.staticExpectedText) {
      refinedSteps.push({
        type: 'assert',
        prompt: buildAssertPrompt(testCase, rawStep, options.baseContext, expectedSplit),
        expected: expectedSplit.staticExpectedText,
        sourceStepNumber: rawStep.stepNumber,
        destructive: false,
        blockedReason: '',
      });
    }

    for (const interaction of expectedSplit.interactions) {
      const interactionDestructive = isDestructiveInteraction(interaction);
      const blockedReason = interactionDestructive && options.safeMode !== false
        ? 'safe mode 默认跳过可能改变业务数据的交互属性验证'
        : '';

      refinedSteps.push({
        type: 'act',
        prompt: buildInteractionActPrompt(testCase, rawStep, interaction, options.baseContext),
        expected: interaction.note,
        sourceStepNumber: rawStep.stepNumber,
        destructive: interactionDestructive,
        blockedReason,
      });
      refinedSteps.push({
        type: 'assert',
        prompt: buildInteractionAssertPrompt(testCase, rawStep, interaction, options.baseContext),
        expected: `${interaction.target}：${interaction.note}`,
        sourceStepNumber: rawStep.stepNumber,
        destructive: interactionDestructive,
        blockedReason,
      });
    }
  }

  return {
    ...testCase,
    refinedSteps,
    missingPreconditions,
    destructive: refinedSteps.some((step) => step.destructive),
  };
}

export function refineCases(cases, options = {}) {
  return cases.map((testCase) => refineCaseSteps(testCase, options));
}

export function isDestructiveStep(step) {
  const text = `${step.actionText ?? ''}\n${step.expectedText ?? ''}`;
  return DESTRUCTIVE_KEYWORDS.some((keyword) => text.includes(keyword));
}

function detectMissingPreconditions(testCase) {
  const text = [
    testCase.preconditionsText,
    testCase.name,
    ...testCase.rawSteps.flatMap((step) => [step.actionText, step.expectedText]),
  ].filter(Boolean).join('\n');

  const matched = DATA_REQUIREMENT_KEYWORDS.filter((keyword) => text.includes(keyword));

  if (!matched.length && !testCase.preconditionsText) {
    return [];
  }

  const requirements = new Set();

  if (testCase.preconditionsText) {
    requirements.add(`需要确认前置条件：${testCase.preconditionsText}`);
  }

  for (const keyword of matched) {
    requirements.add(`可能需要业务测试数据或权限：${keyword}`);
  }

  return [...requirements];
}

function splitExpectedTextForInteractions(expectedText = '') {
  if (!expectedText) {
    return {
      staticExpectedText: '',
      interactions: [],
    };
  }

  const interactions = [];
  const staticLines = expectedText.split('\n').map((line) => {
    let nextLine = line;

    for (const match of line.matchAll(PARENTHETICAL_NOTE_PATTERN)) {
      const note = normalizeText(match[1]);
      if (!isInteractionNote(note)) {
        continue;
      }

      interactions.push({
        target: inferInteractionTarget(line, match.index ?? 0),
        note,
        keyword: pickInteractionKeyword(note),
        originalLine: line.trim(),
      });
      nextLine = nextLine.replace(match[0], '');
    }

    return normalizeStaticExpectedLine(nextLine);
  }).filter(Boolean);

  return {
    staticExpectedText: staticLines.join('\n'),
    interactions,
  };
}

function isInteractionNote(note) {
  return INTERACTION_KEYWORDS.some((keyword) => note.includes(keyword));
}

function isDestructiveInteraction(interaction) {
  const text = `${interaction.target}\n${interaction.note}`;
  return DESTRUCTIVE_KEYWORDS.some((keyword) => text.includes(keyword));
}

function pickInteractionKeyword(note) {
  return INTERACTION_KEYWORDS.find((keyword) => note.includes(keyword)) ?? '交互';
}

function inferInteractionTarget(line, noteStartIndex) {
  const beforeNote = line.slice(0, noteStartIndex);
  const lineWithoutInteractiveNotes = line.replace(PARENTHETICAL_NOTE_PATTERN, (fullMatch, note) => (
    isInteractionNote(normalizeText(note)) ? '' : fullMatch
  ));

  const candidates = [beforeNote, lineWithoutInteractiveNotes, line]
    .map((candidate) => normalizeInteractionTarget(candidate))
    .filter(Boolean);

  return candidates[0] ?? '对应字段或入口';
}

function normalizeInteractionTarget(value) {
  return normalizeText(value)
    .replace(/^\s*(?:\d+|[一二三四五六七八九十]+)[.、．)）]\s*/, '')
    .replace(/[：:，,。；;、\-—\s]+$/g, '')
    .trim();
}

function normalizeStaticExpectedLine(line) {
  return normalizeText(line)
    .replace(/\s+([，。；、:：])/g, '$1')
    .replace(/([（(])\s+/g, '$1')
    .replace(/\s+([）)])/g, '$1')
    .trim();
}

function normalizeText(value) {
  return String(value ?? '').replace(/[\t ]+/g, ' ').trim();
}

function buildStepContext(testCase, rawStep, baseContext = '', expectedSplit = null) {
  return [
    `用例 ${testCase.externalId}：${testCase.name}`,
    testCase.suitePath ? `套件：${testCase.suitePath}` : '',
    baseContext ? `执行上下文：${baseContext}` : '',
    testCase.preconditionsText ? `前置条件：${testCase.preconditionsText}` : '',
    `原始步骤 ${rawStep.stepNumber}`,
    rawStep.actionText ? `动作：${rawStep.actionText}` : '',
    rawStep.expectedText ? `原始预期：${rawStep.expectedText}` : '',
    expectedSplit?.interactions?.length ? `静态预期：${expectedSplit.staticExpectedText || '无，仅包含交互属性验证'}` : '',
    expectedSplit?.interactions?.length ? `已拆分交互属性：${formatInteractionList(expectedSplit.interactions)}` : '',
  ].filter(Boolean).join('\n');
}

function buildActionPrompt(testCase, rawStep, baseContext = '', staticExpectedText = '') {
  return [
    '你正在通过 Midscene Bridge 执行 UI 测试。',
    baseContext ? `当前上下文：${baseContext}` : '请基于当前已打开且已登录的页面执行。',
    `用例：${testCase.externalId} ${testCase.name}`,
    testCase.preconditionsText ? `前置条件：${testCase.preconditionsText}` : '',
    `请执行步骤 ${rawStep.stepNumber}：${rawStep.actionText}`,
    staticExpectedText ? `执行后应便于验证以下静态预期：${staticExpectedText}` : rawStep.expectedText ? `执行后应便于验证以下预期：${rawStep.expectedText}` : '',
    '不要编造页面上不存在的业务对象、账号、数据编号或测试数据；如果页面缺少必要数据，请停止当前步骤并说明原因。',
  ].filter(Boolean).join('\n');
}

function buildAssertPrompt(testCase, rawStep, baseContext = '', expectedSplit) {
  const interactions = expectedSplit?.interactions ?? [];
  const staticExpectedText = expectedSplit?.staticExpectedText ?? rawStep.expectedText;

  return [
    '请根据当前页面状态判断测试预期是否成立。',
    baseContext ? `当前上下文：${baseContext}` : '',
    `用例：${testCase.externalId} ${testCase.name}`,
    `步骤 ${rawStep.stepNumber} 的原始动作：${rawStep.actionText || '无'}`,
    interactions.length ? '这是静态展示断言：只验证字段文案、字段顺序、布局关系和当前已经展示的内容。不要把复制、点击、跳转、下拉、展开、弹窗等交互属性作为本断言的失败原因。' : '',
    `必须满足的${interactions.length ? '静态' : ''}预期：${staticExpectedText}`,
    interactions.length ? `以下交互属性已拆分为后续独立 act/assert 步骤：${formatInteractionList(interactions)}` : '',
    '如果当前页面缺少必要数据或权限，请明确判定为不满足并说明缺失项。',
  ].filter(Boolean).join('\n');
}

function buildInteractionActPrompt(testCase, rawStep, interaction, baseContext = '') {
  return [
    '【交互属性验证 - act】请执行一个不改变业务数据的交互验证动作。',
    baseContext ? `当前上下文：${baseContext}` : '请基于当前已打开且已登录的页面执行。',
    `用例：${testCase.externalId} ${testCase.name}`,
    `来源：步骤 ${rawStep.stepNumber} 预期中的「${interaction.originalLine}」`,
    `验证对象：${interaction.target}`,
    `交互属性：${interaction.note}`,
    describeInteractionAction(interaction),
    '不要提交、保存、删除、关闭、取消、确认或修改业务数据；如果验证会触发这类破坏性操作，请停止并说明原因。',
  ].filter(Boolean).join('\n');
}

function buildInteractionAssertPrompt(testCase, rawStep, interaction, baseContext = '') {
  return [
    '【交互属性验证 - assert】请根据刚才的交互结果判断该交互属性是否成立。',
    baseContext ? `当前上下文：${baseContext}` : '',
    `用例：${testCase.externalId} ${testCase.name}`,
    `来源：步骤 ${rawStep.stepNumber} 预期中的「${interaction.originalLine}」`,
    `验证对象：${interaction.target}`,
    `必须满足的交互属性：${interaction.note}`,
    describeInteractionAssertion(interaction),
    '如果页面缺少目标入口、必要数据或权限，请明确判定为不满足并说明缺失项。',
  ].filter(Boolean).join('\n');
}

function describeInteractionAction(interaction) {
  if (interaction.note.includes('不可复制')) {
    return `请定位「${interaction.target}」，尝试通过安全方式选中文本并复制该字段内容，观察是否无法复制或页面是否明确体现不可复制。`;
  }

  if (interaction.note.includes('可复制')) {
    return `请定位「${interaction.target}」，尝试通过安全方式选中文本并复制该字段内容，观察是否可以复制出有效内容。`;
  }

  if (interaction.note.includes('可查看')) {
    return `请定位「${interaction.target}」，点击、悬停或打开对应入口，尝试查看「${stripLeadingKeyword(interaction.note, '可查看') || interaction.note}」相关信息。`;
  }

  if (interaction.note.includes('下拉')) {
    return `请定位「${interaction.target}」的下拉入口并展开下拉选项，观察选项面板或候选列表是否出现。`;
  }

  if (interaction.note.includes('展开')) {
    return `请定位「${interaction.target}」的展开入口并执行展开，观察隐藏区域或更多内容是否显示。`;
  }

  if (interaction.note.includes('弹窗')) {
    return `请定位「${interaction.target}」并触发对应入口，观察是否打开弹窗、浮层或对话框。`;
  }

  if (interaction.note.includes('可点击') || interaction.note.includes('点击') || interaction.note.includes('跳转')) {
    return `请定位「${interaction.target}」并点击该入口，观察是否发生预期跳转、打开详情页或出现目标内容。`;
  }

  return `请定位「${interaction.target}」并执行与「${interaction.note}」匹配的安全交互验证动作。`;
}

function describeInteractionAssertion(interaction) {
  if (interaction.note.includes('不可复制')) {
    return `确认「${interaction.target}」不可复制：复制不到有效字段内容，或页面存在明确禁用复制/不可复制表现。`;
  }

  if (interaction.note.includes('可复制')) {
    return `确认「${interaction.target}」可复制：可以复制出该字段的有效内容，且复制行为没有被页面阻止。`;
  }

  if (interaction.note.includes('可查看')) {
    return `确认通过「${interaction.target}」可以查看「${stripLeadingKeyword(interaction.note, '可查看') || interaction.note}」相关信息，例如信息区、人员列表、详情浮层或可查看状态。`;
  }

  if (interaction.note.includes('下拉')) {
    return `确认「${interaction.target}」下拉属性成立：下拉面板、候选列表或可选择选项已经显示。`;
  }

  if (interaction.note.includes('展开')) {
    return `确认「${interaction.target}」展开属性成立：隐藏区域、子表格、详情区或更多内容已经显示。`;
  }

  if (interaction.note.includes('弹窗')) {
    return `确认「${interaction.target}」弹窗属性成立：弹窗、浮层、抽屉或对话框已经出现，并与该入口相关。`;
  }

  if (interaction.note.includes('可点击') || interaction.note.includes('点击') || interaction.note.includes('跳转')) {
    return `确认「${interaction.target}」点击/跳转属性成立：页面 URL、标题、详情内容、面包屑、标签页或目标区域体现已经跳转或打开目标内容。`;
  }

  return `确认「${interaction.target}」满足「${interaction.note}」对应的交互属性。`;
}

function stripLeadingKeyword(value, keyword) {
  return normalizeText(value).startsWith(keyword)
    ? normalizeText(value).slice(keyword.length).trim()
    : '';
}

function formatInteractionList(interactions) {
  return interactions
    .map((interaction) => `${interaction.target}（${interaction.note}）`)
    .join('；');
}
