import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { indexPassages, searchPassages, highlightPassage, glossaryEntries, annotateTerms } from './reader.js';
import './style.css';
import './theme.css';
import brandIcon from './assets/codex-assistant.svg';

// Course text is bundled; evidence is published as the original files and fetched on demand,
// so large logs stay byte-for-byte downloadable instead of becoming JavaScript chunks.
const evidenceUrls = import.meta.glob(['../evidence/desktop-lab/**/*.json', '../evidence/desktop-lab/**/*.jsonl', '../evidence/desktop-lab/**/*.md', '../evidence/desktop-lab/**/*.txt'], { query: '?url', import: 'default', eager: true });
const files = {
  ...import.meta.glob(['../GLOSSARY.md', '../course/**/*.md', '../course/**/*.json'], { query: '?raw', import: 'default' }),
  ...Object.fromEntries(Object.entries(evidenceUrls).map(([path, url]) => [path, () => fetch(url).then(response => {
    if (!response.ok) throw new Error('公开文件加载失败：' + path.slice(3));
    return response.text();
  })])),
};
const images = import.meta.glob('../docs/images/**/*.{png,jpg,jpeg,webp,svg}', { query: '?url', import: 'default', eager: true });
const repo = 'https://github.com/chrichuang218/how-codex-works';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const json = value => JSON.stringify(value, null, 2);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fileCache = new Map();
const jsonCache = new Map();
const states = new Map();
const textCopies = new Map();
let textNumber = 0;
let catalog;
let experiments;
let activeLesson = '';
let responseLocations;
let fileLocations;
let relations;
let toastTimer;
let routeNumber = 0;
let searchNumber = 0;
let evidenceObserver;
let sectionIds;
let glossary;
let searchIndex;
let menuOpener;
let termOpener;
let readingReady = false;
let saveTimer;
let evidenceReturn;
const pageLoads = new Map();
const diagramRenders = new WeakMap();
const outlines = new Map();
const collapsedOutlines = new Set();

function readPosition(key = 'ah-reading-position') {
  try {
    const position = JSON.parse(localStorage.getItem(key));
    return position && (position.lesson === 'introduction' || catalog.lessons.some(lesson => lesson.id === position.lesson)) && Number.isFinite(position.offset) ? position : null;
  } catch { return null; }
}
function positionHref(position) { return href(position.lesson, { section: position.section || undefined, offset: Math.round(position.offset) }); }
function currentPosition() {
  const page = document.querySelector('[data-reader-page]:not([hidden])');
  if (!page) return null;
  const headings = [...page.querySelectorAll('.prose [data-passage],.agent-loop-timeline')].filter(node => node.getClientRects().length && node.getBoundingClientRect().top <= 140);
  const current = headings.at(-1);
  const lesson = catalog.lessons.find(item => item.id === activeLesson);
  const heading = (outlines.get(activeLesson) || []).filter(item => {
    const node = document.getElementById(item.id); return node?.getClientRects().length && node.getBoundingClientRect().top <= 140;
  }).at(-1);
  return { lesson: activeLesson, section: current?.id || '', offset: current ? 88 - current.getBoundingClientRect().top : scrollY, label: [lesson?.title || '导读与实验准备', heading?.text].filter(Boolean).join(' · ') };
}
function saveReadingPosition() {
  if (!readingReady) return;
  const workbench = document.querySelector('[data-reader-page]:not([hidden]) .workbench');
  if (workbench && workbench.getBoundingClientRect().top < 160) return;
  const position = currentPosition();
  if (position) try { localStorage.setItem('ah-reading-position', JSON.stringify(position)); } catch { /* Reading works without storage. */ }
}
function refreshContinueReading() {
  const position = readPosition();
  const host = document.querySelector('#continue-reading');
  host.hidden = !position;
  host.innerHTML = position ? `<a href="${esc(positionHref(position))}">继续阅读：${esc(position.label)}</a><small>仅记住阅读位置，不代表已经掌握。</small>` : '';
}
function returnReadingMarkup() {
  return evidenceReturn ? `<a data-return-reading href="${esc(positionHref(evidenceReturn))}">← 返回原阅读位置</a>` : '';
}
function refreshReadingReturns() {
  document.querySelectorAll('.reading-return').forEach(host => host.innerHTML = returnReadingMarkup());
}
function guideTargets(lesson) {
  return (lesson.readingGuide?.targets || []).map(target => `<a href="${esc(evidenceHref(lesson.id, target.experiment, target.stage, target.view, { input: target.input, content: target.content, kind: target.kind }))}">${esc(target.label)}</a>`).join('');
}
function nonnegativeInteger(value) {
  if (value === null || value === undefined || String(value).trim() === '') return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
function initialWorkbenchPosition(lesson, experimentId) {
  const target = (lesson.readingGuide?.targets || []).find(item => !experimentId || item.experiment === experimentId);
  const experiment = experiments.find(item => item.id === (target?.experiment || experimentId || lesson.evidenceIds[0]));
  return {
    experimentId: experiment.id,
    stage: Math.min(nonnegativeInteger(target?.stage) ?? Math.max(0, experiment.stages.findIndex(stage => !stage.prewarm)), experiment.stages.length - 1),
    view: target?.view || 'request',
    rawKind: target?.kind || 'requestFile',
    explicitFocus: null,
  };
}
function workbenchHref(state) {
  const extra = state.view === 'raw' ? { kind: state.rawKind } : state.view === 'request' ? state.explicitFocus || {} : {};
  return evidenceHref(state.lessonId, state.experimentId, state.stage, state.view, extra);
}
const isToolResult = item => /^(custom_tool_call_output|function_call_output|tool_call_output)$/.test(item.type || '');
function validInputFocus(focus, inputs) {
  if (!focus) return null;
  const input = nonnegativeInteger(focus.input);
  if (input === undefined || !inputs[input]) return null;
  if (focus.content === undefined) return { input };
  const content = nonnegativeInteger(focus.content);
  return content !== undefined && Array.isArray(inputs[input].content) && content < inputs[input].content.length ? { input, content } : null;
}
function requestFocus(request, state) {
  const inputs = Array.isArray(request.input) ? request.input : [];
  state.explicitFocus = validInputFocus(state.explicitFocus, inputs);
  if (state.explicitFocus) return [state.explicitFocus];
  const targets = (catalog.lessons.find(lesson => lesson.id === state.lessonId).readingGuide?.targets || [])
    .filter(target => target.experiment === state.experimentId && target.stage === state.stage && target.view === 'request')
    .map(target => validInputFocus(target, inputs)).filter(Boolean);
  if (targets.length) return targets;
  if (inputs.length && inputs.every(isToolResult)) return inputs.map((_, input) => ({ input }));
  const normalize = text => String(text || '').replace(/\r\n?/g, '\n').trim();
  const prompt = normalize(experiments.find(experiment => experiment.id === state.experimentId).prompt);
  if (!prompt) return [];
  const input = inputs.findLastIndex(item => item.role === 'user' && Array.isArray(item.content) && item.content.some(block => normalize(block.text) === prompt));
  return input < 0 ? [] : [{ input, content: inputs[input].content.findLastIndex(block => normalize(block.text) === prompt) }];
}
function openRequestFocus(host, focus) {
  for (const target of focus) {
    const item = host.querySelector(`[data-item-path="input[${target.input}]"]`);
    if (!item) continue;
    item.open = true;
    if (target.content !== undefined) {
      const block = item.querySelector(`[data-content-path="input[${target.input}].content[${target.content}]"]`);
      if (block) block.open = true;
    }
  }
}

function loadFile(path) {
  if (!files['../' + path]) return Promise.reject(new Error('未找到公开文件：' + path));
  if (!fileCache.has(path)) fileCache.set(path, files['../' + path]().catch(error => { fileCache.delete(path); throw error; }));
  return fileCache.get(path);
}
async function loadJson(path) {
  if (!jsonCache.has(path)) jsonCache.set(path, loadFile(path).then(JSON.parse).catch(error => { jsonCache.delete(path); throw error; }));
  return jsonCache.get(path);
}
function href(id, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null)).toString();
  return (id === 'introduction' ? '#/guide' : '#/lesson/' + encodeURIComponent(id)) + (query ? '?' + query : '');
}
function evidenceHref(lessonId, experimentId, stage, view = 'request', extra = {}) {
  return href(lessonId, { experiment: experimentId, stage, view, ...extra });
}
const lessonNumber = lesson => String(catalog.lessons.indexOf(lesson) + 1).padStart(2, '0');
const stageLabel = (stage, experiment) => `${stage.prewarm ? '预热' : experiment.requestKind === 'compaction' ? '压缩请求' : '正式请求'} · ${stage.id}`;
function preferredLesson(experimentId, preferred = activeLesson) {
  return catalog.lessons.find(lesson => lesson.id === preferred && lesson.evidenceIds.includes(experimentId)) || catalog.lessons.find(lesson => lesson.evidenceIds.includes(experimentId));
}
function copyButton(text, label = '复制全文') {
  const id = ++textNumber;
  textCopies.set(id, String(text));
  return `<button type="button" data-copy="${id}">${label}</button>`;
}
function releaseCopies(container) {
  container.querySelectorAll('[data-copy]').forEach(button => textCopies.delete(Number(button.dataset.copy)));
}
function codePanel(text, title = '完整内容', attrs = '') {
  // A code child prevents HTML's initial-pre-newline removal; character
  // references preserve CR characters that the HTML parser would normalize.
  return `<div class="code-panel"><div class="code-toolbar"><span>${esc(title)}</span>${copyButton(text)}</div><pre tabindex="0" ${attrs}><code>${esc(text).replace(/\r/g, '&#13;')}</code></pre></div>`;
}
function rawDetails(value, label = '展开完整 JSON', open = false) {
  return `<details class="raw-details" ${open ? 'open' : ''}><summary>${esc(label)}</summary>${codePanel(json(value), '完整 JSON')}</details>`;
}
function metadata(value) {
  return `<dl class="metadata">${Object.entries(value).map(([key, text]) => `<div><dt>${esc(key)}</dt><dd>${esc(typeof text === 'object' ? json(text) : text)}</dd></div>`).join('')}</dl>`;
}
function contentBlocks(content, prefix, open = false) {
  if (!Array.isArray(content)) return codePanel(typeof content === 'string' ? content : json(content), prefix + ' · 完整字段');
  return content.map((block, index) => {
    const path = `${prefix}[${index}]`;
    const text = typeof block.text === 'string' ? block.text : null;
    const body = text === null ? json(block) : text;
    const preview = body.replace(/\s+/g, ' ').slice(0, 90);
    return `<details class="content-block" data-content-path="${esc(path)}" ${open ? 'open' : ''}><summary><code>${esc(path)}</code> <span>${esc(block.type || '无 type 字段')}</span><small>${text === null ? '完整对象' : `${text.length.toLocaleString()} 字符`}</small></summary><p class="content-preview">预览：${esc(preview)}${body.length > 90 ? '…（展开下方完整文本）' : ''}</p>${codePanel(body, text === null ? '完整内容块 JSON' : '完整 text 原文 · 可滚动', `data-full-content="${esc(path)}"`)}${text === null ? '' : rawDetails(block, '查看该内容块的所有字段')}</details>`;
  }).join('');
}
function toolsMarkup(tools, path) {
  if (!Array.isArray(tools)) return codePanel(json(tools), path + ' · 完整工具定义');
  return `<p class="field-note">${esc(path)} 含 ${tools.length} 个顶层定义，namespace 中的工具保留在对应定义中。</p>${tools.map((tool, index) => `<details class="tool-definition"><summary><code>${esc(path)}[${index}]</code> ${esc(tool.name || tool.type)} <small>${esc(tool.type)}${Array.isArray(tool.tools) ? ` · ${tool.tools.length} 个内层工具` : ''}</small></summary>${codePanel(json(tool), '完整工具定义 · 含描述和参数', `data-tool-path="${esc(path)}[${index}]"`)}</details>`).join('')}`;
}
function itemMarkup(item, prefix, index, output = false) {
  const path = `${prefix}[${index}]`;
  const isResult = isToolResult(item);
  const isCall = /tool_call$|function_call$/.test(item.type || '');
  const open = output && (item.type === 'message' || isCall);
  let body = '';
  if (has(item, 'content')) body += contentBlocks(item.content, path + '.content', open);
  if (has(item, 'tools')) body += toolsMarkup(item.tools, path + '.tools');
  for (const key of ['input', 'arguments', 'output']) if (has(item, key)) {
    body += codePanel(typeof item[key] === 'string' ? item[key] : json(item[key]), `${path}.${key} · 完整字段`, `data-value-path="${path}.${key}"`);
  }
  const visibleMetadata = Object.fromEntries(['name', 'namespace', 'call_id', 'id', 'status', 'phase'].filter(key => has(item, key)).map(key => [key, item[key]]));
  if (Object.keys(visibleMetadata).length) body = metadata(visibleMetadata) + body;
  if (!body) body = codePanel(json(item), path + ' · 完整项目');
  return `<details class="trace-item" data-item-path="${path}" ${open ? 'open' : ''}><summary><code>${path}</code><span class="role-badge">${esc(item.role || '无 role 字段')}</span><strong>${esc(item.type || '未标注 type')}</strong><span class="item-description">${isResult ? '工具返回结果' : isCall ? '模型提出的调用' : item.type === 'additional_tools' ? '可用工具定义' : Array.isArray(item.content) ? item.content.length + ' 个内容块' : ''}</span></summary><div class="trace-item-body">${body}${rawDetails(item, '查看这个项目的完整原始 JSON')}</div></details>`;
}
function requestMarkup(request) {
  const input = request.input;
  const toolPaths = (Array.isArray(input) ? input : []).flatMap((item, index) => has(item, 'tools') ? [`input[${index}].tools`] : []);
  if (has(request, 'tools')) toolPaths.unshift('tools');
  const top = Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'input'));
  return `<div class="request-intro"><p>输入按原数组顺序排列。展开可查看 <code>role</code>、内容块和工具结果；复制按钮复制完整字段。</p><p>工具定义位置：${toolPaths.length ? toolPaths.map(path => `<code>${path}</code>`).join('、') : '本次请求未包含工具定义'}。顶层 <code>instructions</code>：${has(request, 'instructions') ? '存在（下方可展开）' : '不存在'}。</p></div>${has(request, 'instructions') ? codePanel(typeof request.instructions === 'string' ? request.instructions : json(request.instructions), '顶层 instructions · 完整内容') : ''}${has(request, 'tools') ? toolsMarkup(request.tools, 'tools') : ''}<div class="input-actions"><strong>input · ${Array.isArray(input) ? input.length : '非数组'} 项</strong><button data-expand-inputs>展开全部输入与内容块</button><button data-collapse-inputs>收起全部输入</button></div>${Array.isArray(input) ? input.map((item, index) => itemMarkup(item, 'input', index)).join('') : codePanel(json(input), '完整 input 字段')}${rawDetails(top, '查看所有请求级字段（input 已在上方逐项展示）')}`;
}
function outputMarkup(derived, completed) {
  const items = derived?.items || completed?.response?.output || [];
  return `<p class="evidence-notice">${derived ? '输出项按 response.output_item.done 事件顺序汇集，属于衍生视图；response.completed 保留原记录。' : '以下为完成事件中记录的 output。'}</p>${items.length ? items.map((item, index) => itemMarkup(item, 'output', index, true)).join('') : '<p class="empty-state">本阶段没有记录到输出项。请结合预热标记、完成事件及流式事件判断。</p>'}${rawDetails(completed, '展开原始 response.completed 完成事件')}`;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function responseLink(id, preferred, label = id) {
  if (!id) return '<span class="muted">无（未携带该字段）</span>';
  const location = responseLocations.get(id)?.[0];
  const lesson = location && preferredLesson(location.experiment.id, preferred);
  return lesson ? `<a href="${esc(evidenceHref(lesson.id, location.experiment.id, location.index, 'output'))}">${esc(label)}</a>` : `<code>${esc(label)}</code><small> · 此响应未收录</small>`;
}

function workbenchShell(lesson) {
  return `<section class="workbench" id="workbench-${lesson.id}" data-workbench="${lesson.id}" aria-busy="false"><div class="reading-return">${returnReadingMarkup()}</div><div class="workbench-head"><h3>内嵌证据工作台</h3>${lesson.readingGuide ? `<div class="evidence-focus"><strong>本章重点</strong><p>${esc(lesson.readingGuide.focus)}</p><div class="reading-targets">${guideTargets(lesson)}</div></div>` : ''}<p class="workbench-intro">选择本章实验和请求，按需展开完整记录；预热请求也在列表中。</p><div class="workbench-selectors"><label>实验 <select class="experiment-select" aria-label="选择实验">${lesson.evidenceIds.map(id => { const experiment = experiments.find(item => item.id === id); return `<option value="${esc(id)}">${esc(experiment?.title || id)}</option>`; }).join('')}</select></label><label>请求 <select class="stage-select" aria-label="选择请求"></select></label></div><div class="experiment-summary"></div><div class="request-controls"><button data-stage-prev>← 上一次请求</button><button data-stage-next>下一次请求 →</button><button data-share>复制此位置链接</button></div><div class="request-metadata"></div><div class="workbench-tabs" aria-label="工作台视图"><button data-view="request">输入与工具定义</button><button data-view="output">模型输出</button><button data-view="calls">工具调用与结果</button><button data-view="compare">客户端 / 上游</button><button data-view="raw">原始记录</button></div></div><div class="workbench-content"><button class="load-evidence">加载本次请求</button></div></section><section class="supplement" id="supplement-${lesson.id}" hidden aria-label="补充原始证据"></section>`;
}
const helloParts = ['工具定义', 'Codex 工作说明', 'Desktop 能力、技能目录、权限与协作', '多 Agent 角色', '多 Agent 约束', '插件、AGENTS 规则、环境信息', '“你好”'];
const loopSteps = [
  ['R0', '读取项目', '模型用一次 exec 安排读取技能、文件清单和项目文件。'],
  ['R1', '搜索调用位置', '模型搜索 calculateTotal 的定义、调用位置和项目规则。'],
  ['R2', '修改代码与说明', '模型提出补丁，把加法改为乘法，并更新 README 的状态说明。'],
  ['R3', '验证修改', '模型安排类型检查、测试和示例运行，并重读修改后的文件。'],
  ['R4', '汇报结果', '模型汇报修复与验证结果，没有再提出工具调用。'],
];
const arrowIcon = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const checkIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function chapterKicker(lesson) {
  const count = lesson.evidenceIds.length;
  const status = lesson.status === 'partial' ? '含待验证内容' : `实测记录 · ${count} 组实验`;
  return `<p class="chapter-kicker"><span>第 ${lessonNumber(lesson)} 章</span><span class="status-chip">${lesson.status === 'partial' ? '' : checkIcon}${status}</span></p>`;
}
function evidenceRail(lesson) {
  const target = lesson.readingGuide?.targets?.[0];
  const experiment = experiments.find(item => item.id === (target?.experiment || lesson.evidenceIds[0]));
  if (!experiment) return '';
  const stats = experiment.stats || {};
  const others = lesson.evidenceIds.filter(id => id !== experiment.id).length;
  return `<aside class="evidence-rail" aria-label="本章证据"><div class="rail-card"><header><p>本章证据</p><strong>${esc(experiment.title)}</strong></header><dl><div><dt>模型请求</dt><dd>${stats.requests ?? '—'}</dd></div><div><dt>工具调用</dt><dd>${stats.toolCalls ?? '—'}</dd></div><div class="wide"><dt>输入 token 合计</dt><dd>${Number(stats.inputTokens || 0).toLocaleString('en-US')}</dd></div></dl>${others ? `<p class="rail-more">本章另有 ${others} 组关联实验</p>` : ''}<a class="rail-open" href="${href(lesson.id, { section: 'workbench-' + lesson.id })}">打开证据工作台</a></div>${lesson.readingGuide ? `<div class="rail-focus"><p>本章重点</p><p>${esc(lesson.readingGuide.focus)}</p></div>` : ''}</aside>`;
}
function homeMarkup() {
  const stageCount = experiments.reduce((sum, experiment) => sum + experiment.stages.length, 0);
  return `<section class="home-page" id="home-view">
<header class="home-hero"><div class="hero-copy">
<span class="eyebrow">基于 Codex Desktop 的真实请求日志</span>
<h1>Codex<br class="hero-break"> 是如何工作的</h1>
<p class="hero-lead">给 Codex 发一句“你好”，就是这份教程的 Hello World。模型收到的远不止这两个字：用一个简单的 TypeScript 项目做实验，逐项打开请求、响应和请求中可见的完整上下文。</p>
<div class="hero-actions"><a class="primary-button" data-start-learning href="${href(catalog.lessons[0].id)}">从第 1 章开始 ${arrowIcon}</a><a class="secondary-button" href="#/guide">阅读导读</a></div>
<div class="hero-evidence-links"><a data-hello-request href="${evidenceHref('01-request', '01-hello', 1, 'request')}">打开“你好”的真实请求</a><span aria-hidden="true">·</span><a data-hello-response href="${evidenceHref('01-request', '01-hello', 1, 'output')}">查看响应与输出</a></div>
<div id="continue-reading" hidden></div>
<dl class="hero-stats"><div><dt>主题</dt><dd>${catalog.lessons.length} 章</dd></div><div><dt>真实实验</dt><dd>${experiments.length} 组</dd></div><div><dt>请求阶段</dt><dd>${stageCount} 个</dd></div></dl>
<p class="reading-options">无需安装即可阅读。亲自复现前，请先看<a href="#/guide">环境准备</a>。</p>
</div>
<figure class="token-anatomy" data-token-anatomy aria-busy="true"><figcaption class="token-anatomy-head"><strong>发送“你好”时，模型收到了什么</strong><a href="${evidenceHref('01-request', '01-hello', 1, 'request')}">01-hello / 01-request</a></figcaption><div class="token-anatomy-body"><p class="token-note">正在读取这次请求的计量…</p></div></figure>
</header>
<section class="learning-path" aria-labelledby="path-title"><div class="home-band">
<div class="home-section-head"><div><span class="eyebrow">学习路线</span><h2 id="path-title">四个阶段，沿同一个项目读下去</h2></div><p>每章从一个界面操作出发，再到日志里找答案。章末留一道题，先自己判断，再展开对照。</p></div>
<div class="phase-grid">${catalog.groups.map((group, index) => `<section class="phase-section" data-phase="${group.id}"><header class="phase-header"><span class="phase-number">阶段 ${index + 1}</span><h3>${esc(group.title)}</h3><p>${esc(group.description)}</p></header><div class="lesson-grid">${catalog.lessons.filter(lesson => lesson.group === group.id).map(lesson => `<a class="lesson-card" href="${href(lesson.id)}" data-card-lesson="${lesson.id}" title="${esc(lesson.subtitle)}"><span class="card-top"><span>${lessonNumber(lesson)}</span></span><h4>${esc(lesson.title)}</h4>${lesson.status === 'partial' ? '<small class="card-status">含待验证内容</small>' : ''}</a>`).join('')}</div></section>`).join('')}</div>
</div></section>
<section class="home-example" aria-label="贯穿教程的修复案例"><div class="example-copy">
<span class="eyebrow">第 3 章 · 完整修复案例</span>
<h2>10 × 3，为什么得到 13？</h2>
<p>项目把单价和数量相加，测试期望 30 元。一次“修好它”的要求，在日志里是五次模型请求和四次工具往返：读文件、找位置、改代码、跑验证，最后汇报。</p>
<div class="bug-example"><div class="bug-before"><code>- return unitPrice + quantity;</code><span>13</span></div><div class="bug-after"><code>+ return unitPrice * quantity;</code><span>30</span></div></div>
<a class="example-link" href="${href('03-agent-loop', { section: 'agent-loop-timeline' })}">沿时间线看五次请求 ${arrowIcon}</a>
</div>
<ol class="loop-steps">${loopSteps.map(([id, title, text]) => `<li><span class="loop-mark" aria-hidden="true"><b>${id}</b><i></i></span><div><h3>${title}</h3><p>${text}</p></div></li>`).join('')}</ol>
</section>
<section class="home-evidence" aria-labelledby="evidence-title"><div class="home-band">
<span class="eyebrow">证据工作台</span>
<h2 id="evidence-title">每个结论都能回到原始记录</h2>
<p class="lead">正文里的说法都链接到对应的请求阶段。工作台可以按输入项展开、按编号配对工具调用，也可以对照客户端与上游的两份记录。</p>
<div class="view-cards">
<article><div><h3>输入与工具定义</h3><p>按 input 序号展开每一项，分清应用说明、项目规则和用户原话。</p></div><pre>input[6]  message · user
  content[0].text = "你好\\n"</pre></article>
<article><div><h3>工具调用与结果</h3><p>用同一个 call_id 把模型提出的动作和本地返回的结果配对。</p></div><pre>custom_tool_call         exec
custom_tool_call_output  exit_code: 0
call_id  call_a288dLl8tyNv8JFlTJgNdtfK</pre></article>
<article><div><h3>客户端与上游对照</h3><p>并排查看 Desktop 发出的请求与 CPA 转发到上游的记录。</p></div><pre>client    01-request.request.json
upstream  01-request.upstream.json</pre></article>
</div>
<p class="privacy-note">公开记录已脱敏，敏感内容以占位符替换；“完整上下文”限于所保存请求中可见的内容。</p>
</div></section>
</section>`;
}
let tokenAnatomyState = 'idle';
async function renderTokenAnatomy() {
  const figure = document.querySelector('[data-token-anatomy]');
  if (!figure || tokenAnatomyState !== 'idle') return;
  tokenAnatomyState = 'loading';
  const body = figure.querySelector('.token-anatomy-body');
  try {
    const stage = experiments.find(item => item.id === '01-hello').stages.find(item => !item.prewarm);
    const [request, response] = await Promise.all([loadJson(stage.requestFile), loadJson(stage.responseFile)]);
    const usage = (response.response || response).usage;
    const attributed = usage.attribution.items;
    const parts = request.input.map((item, index) => ({ index, label: helloParts[index] || item.type, tokens: attributed[item.id]?.input_tokens ?? 0 }));
    const counted = parts.reduce((sum, part) => sum + part.tokens, 0);
    const user = parts.at(-1);
    const color = part => part === user ? 'var(--teal)' : `var(--seg-${Math.min(part.index, 5)})`;
    const number = value => value.toLocaleString('en-US');
    body.innerHTML = `<p class="token-total"><b>${number(usage.input_tokens)}</b><span>个输入 token，其中“你好”只有 <strong>${number(user.tokens)}</strong> 个</span></p>
<div class="token-bar" role="img" aria-label="${parts.length} 个输入项的 token 占比">${parts.map(part => `<span style="flex:${part.tokens} 1 0;--seg:${color(part)}"></span>`).join('')}</div>
<ul class="token-list">${parts.map(part => `<li${part === user ? ' class="is-user"' : ''}><i style="--seg:${color(part)}"></i><code>input[${part.index}]</code><span>${esc(part.label)}</span><b>${number(part.tokens)}</b></li>`).join('')}</ul>
<p class="token-note">数据来自本次响应的 <code>usage.attribution</code>${usage.input_tokens > counted ? `，另有 ${number(usage.input_tokens - counted)} 个 token 计在回答消息下` : ''}。</p>`;
    tokenAnatomyState = 'done';
  } catch (error) {
    console.error(error);
    tokenAnatomyState = 'idle';
    body.innerHTML = '<p class="token-note">暂时无法读取这次请求的计量，可以直接打开原始请求查看。</p>';
  } finally {
    figure.setAttribute('aria-busy', 'false');
  }
}
function shell() {
  document.querySelector('#app').innerHTML = `<a class="skip-link" href="#main">跳至正文</a><header class="site-header"><div class="header-start"><button class="menu-toggle" aria-label="展开学习目录" aria-controls="course-sidebar" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button><a class="brand" href="#/" aria-label="回到教程首页"><img class="brand-icon" src="${brandIcon}" width="31" height="31" alt=""><span>How Codex Works</span></a></div><div class="header-actions"><button id="theme-toggle" class="icon-button" type="button" aria-label="切换深浅主题" aria-pressed="false"><svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg><svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button><a class="github-link icon-button" href="${repo}" target="_blank" rel="noopener" aria-label="在 GitHub 查看项目源码"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5a9.5 9.5 0 0 0-3 18.5c.5.1.7-.2.7-.5v-1.7c-2.7.6-3.2-1.2-3.2-1.2-.4-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.1-.2-4.4-1.1-4.4-4.8 0-1 .4-1.9 1-2.6-.1-.3-.4-1.2.1-2.6 0 0 .8-.3 2.6 1a9 9 0 0 1 4.8 0c1.8-1.3 2.6-1 2.6-1 .5 1.4.2 2.3.1 2.6.6.7 1 1.6 1 2.6 0 3.7-2.3 4.6-4.4 4.8.3.3.7.9.7 1.8v2.7c0 .3.2.6.7.5A9.5 9.5 0 0 0 12 2.5Z" fill="currentColor"/></svg></a></div></header><div class="mobile-shade" hidden></div><aside id="course-sidebar" class="course-sidebar" aria-label="课程目录与搜索"><div class="directory-search"><span aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span><input id="chapter-search" type="search" aria-label="搜索文档" placeholder="搜索课程…"><button id="clear-search" aria-label="清除搜索" hidden>×</button></div><p id="search-status" role="status" aria-live="polite" hidden></p><div id="search-results" hidden></div><nav id="chapter-nav" aria-label="教程目录">${navMarkup()}</nav></aside><main id="main" tabindex="-1" aria-busy="true">${homeMarkup()}<section class="reader-page" id="reader-view" hidden><nav class="breadcrumb" aria-label="当前位置"></nav><div class="reading-layout"><div class="reading-content"><div id="lesson-content"></div><nav class="chapter-pagination" aria-label="章节翻页"></nav></div></div></section></main><footer class="site-footer"><div><a href="#/">Codex 是如何工作的</a></div></footer><button id="back-top" aria-label="回到顶部">↑</button><div class="toast" role="status" aria-live="polite"></div><aside id="term-definition" class="term-popover" popover aria-label="术语解释"><button data-close-term aria-label="关闭术语解释">×</button><strong></strong><p></p><a></a></aside>`;
  document.querySelector('#theme-toggle').onclick = () => {
    document.documentElement.classList.toggle('dark');
    syncThemeButton();
    try { localStorage.setItem('ah-theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light'); } catch { /* Theme remains usable without storage. */ }
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => {
    let saved = null;
    try { saved = localStorage.getItem('ah-theme'); } catch { /* Without storage, keep following the system. */ }
    if (saved === 'dark' || saved === 'light') return;
    document.documentElement.classList.toggle('dark', event.matches);
    syncThemeButton();
  });
  document.querySelector('.menu-toggle').onclick = () => toggleMenu(!sidebarIsOpen());
  document.querySelector('.mobile-shade').onclick = () => toggleMenu(false);
  document.querySelector('.skip-link').onclick = event => { event.preventDefault(); document.querySelector('#main').focus(); document.querySelector('#main').scrollIntoView(); };
  document.querySelector('#back-top').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  document.querySelector('#chapter-search').oninput = () => filterNavigation().catch(error => { console.error(error); showToast('搜索暂时不可用'); });
  document.querySelector('#clear-search').onclick = () => { document.querySelector('#chapter-search').value = ''; filterNavigation(); document.querySelector('#chapter-search').focus(); };
  document.querySelector('#term-definition').addEventListener('toggle', event => { if (event.newState === 'closed') termOpener?.setAttribute('aria-expanded', 'false'); });
  matchMedia('(max-width: 760px)').addEventListener('change', () => {
    document.body.classList.remove('menu-open'); syncSidebar();
    if (document.activeElement.closest('[inert]')) document.querySelector('.menu-toggle').focus({ preventScroll: true });
  });
  document.addEventListener('click', handleClick);
  document.addEventListener('change', event => {
    const host = event.target.closest('[data-workbench]');
    if (!host) return;
    const state = states.get(host.dataset.workbench);
    if (event.target.matches('.experiment-select')) { Object.assign(state, initialWorkbenchPosition(catalog.lessons.find(lesson => lesson.id === state.lessonId), event.target.value)); renderWorkbench(state); }
    if (event.target.matches('.stage-select')) { state.stage = Number(event.target.value); state.explicitFocus = null; renderWorkbench(state); }
    if (event.target.matches('.raw-select')) { state.rawKind = event.target.value; renderWorkbench(state); }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.querySelector('#term-definition').matches(':popover-open')) {
      event.preventDefault(); document.querySelector('#term-definition').hidePopover(); termOpener?.focus({ preventScroll: true }); return;
    }
    if (event.key === 'Escape' && document.body.classList.contains('menu-open')) toggleMenu(false);
    if (event.key === 'Tab' && document.body.classList.contains('menu-open')) {
      const focusable = [document.querySelector('.menu-toggle'), ...document.querySelector('.course-sidebar').querySelectorAll('a,button,input,select,[tabindex="0"]')].filter(node => !node.disabled && node.getClientRects().length);
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    if ((event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) || ((event.ctrlKey || event.metaKey) && event.key === 'k')) { event.preventDefault(); toggleMenu(true); document.querySelector('#chapter-search').focus(); }
  });
  evidenceObserver = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting || entry.target.closest('[hidden]')) return;
    const state = states.get(entry.target.dataset.workbench);
    if (!state.loaded) renderWorkbench(state, false);
  }), { rootMargin: '-64px 0px 150px 0px' });
  syncThemeButton(); syncSidebar(); refreshContinueReading();
}
function setDescription(text) {
  // Keep the per-chapter summary available to bookmarks, reader modes and browser history.
  if (text) document.querySelector('meta[name="description"]')?.setAttribute('content', text);
}
function syncThemeButton() {
  const dark = document.documentElement.classList.contains('dark');
  const button = document.querySelector('#theme-toggle');
  button.title = dark ? '切换至浅色主题' : '切换至深色主题';
  button.setAttribute('aria-pressed', String(dark));
}
function sidebarOverlay() {
  return matchMedia('(max-width: 760px)').matches || document.body.dataset.view !== 'reader';
}
function sidebarIsOpen() {
  return sidebarOverlay() ? document.body.classList.contains('menu-open') : !document.body.classList.contains('sidebar-collapsed');
}
function syncSidebar() {
  const open = sidebarIsOpen();
  const overlayOpen = open && sidebarOverlay();
  const sidebar = document.querySelector('.course-sidebar');
  sidebar.inert = !open;
  sidebar.setAttribute('aria-hidden', String(!open));
  document.querySelector('.mobile-shade').hidden = !overlayOpen;
  const toggle = document.querySelector('.menu-toggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? '收起学习目录' : '展开学习目录');
  // Keep the same toggle available while the drawer is open.
  for (const node of document.querySelectorAll('#main,.site-footer,.brand,.header-actions,#back-top')) node.inert = overlayOpen;
}
function toggleMenu(open, restoreFocus = true) {
  if (!sidebarOverlay()) {
    document.body.classList.toggle('sidebar-collapsed', !open);
    syncSidebar();
    if (document.activeElement.closest('[inert]')) document.querySelector('.menu-toggle').focus({ preventScroll: true });
    return;
  }
  const wasOpen = document.body.classList.contains('menu-open');
  if (open && !wasOpen) menuOpener = document.activeElement;
  document.body.classList.toggle('menu-open', open);
  syncSidebar();
  if (open) document.querySelector('#chapter-search').focus();
  else if (wasOpen && restoreFocus && menuOpener?.isConnected && !menuOpener.closest('[inert]')) menuOpener.focus({ preventScroll: true });
  else if (wasOpen || document.activeElement.closest('.course-sidebar[inert]')) document.querySelector('#main').focus({ preventScroll: true });
}
function navMarkup() {
  return `<a class="chapter-link home-link" href="#/">学习路线</a>${chapterNavMarkup({ id: 'introduction', title: '导读与实验准备' })}${catalog.groups.map((group, index) => `<div class="nav-group"><h2><span class="nav-phase-label">阶段 ${index + 1}</span><span class="nav-group-title">${esc(group.title)}</span></h2>${catalog.lessons.filter(lesson => lesson.group === group.id).map(chapterNavMarkup).join('')}</div>`).join('')}`;
}
function chapterNavMarkup(lesson) {
  const introduction = lesson.id === 'introduction';
  return `<div class="nav-chapter" data-nav-lesson="${lesson.id}"><div class="chapter-row"><a class="chapter-link${introduction ? ' intro-link' : ''}" href="${href(lesson.id)}">${introduction ? '' : `<span class="nav-number">${lessonNumber(lesson)}</span>`}<span class="nav-title">${esc(lesson.title)}</span></a><button type="button" class="chapter-toggle" data-toggle-outline="${lesson.id}" aria-controls="outline-${lesson.id}" aria-expanded="false" aria-label="展开${esc(lesson.title)}的小节" hidden><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div></div>`;
}
function syncOutlineVisibility(id) {
  const chapter = document.querySelector(`[data-nav-lesson="${id}"]`);
  const outline = chapter?.querySelector('.chapter-outline');
  if (!outline) return;
  const expanded = !collapsedOutlines.has(id);
  outline.hidden = !expanded;
  const button = chapter.querySelector('[data-toggle-outline]');
  const title = id === 'introduction' ? '导读与实验准备' : catalog.lessons.find(lesson => lesson.id === id).title;
  button.setAttribute('aria-expanded', String(expanded));
  button.setAttribute('aria-label', `${expanded ? '收起' : '展开'}${title}的小节`);
  button.title = button.getAttribute('aria-label');
}
function resolveDocumentPath(path, base) { return new URL(path, 'https://local.invalid/' + base).pathname.slice(1); }
function resolveSection(lessonId, fragment) {
  if (!fragment) return undefined;
  const target = decodeURIComponent(fragment);
  const slug = text => text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  return Object.entries(sectionIds[lessonId] || {}).find(([text, id]) => id === target || text === target || slug(text) === target)?.[1] || target;
}
const highlightLanguages = /(?:^|\s)language-(?:json|ts|typescript|js|javascript|bash|powershell|diff|toml|markdown)(?:\s|$)/;
function highlightCode(container) {
  const codes = [...container.querySelectorAll('pre > code')].filter(code => highlightLanguages.test(code.className));
  if (!codes.length) return;
  import('./highlight.js').then(({ highlight }) => codes.forEach(highlight)).catch(error => console.warn('代码着色不可用', error));
}
function decorateMarkdown(container, lesson) {
  const { outline: headings } = indexPassages(container, lesson, sectionIds);
  headings.forEach(({ id }) => {
    const heading = container.querySelector('#' + CSS.escape(id));
    if (heading.tagName === 'SUMMARY') heading.style.scrollMarginTop = '88px';
    const anchor = document.createElement('a'); anchor.className = 'heading-anchor'; anchor.href = href(lesson.id, { section: id }); anchor.textContent = '#'; anchor.setAttribute('aria-label', '链接到这一段'); heading.append(anchor);
  });
  container.querySelectorAll('img').forEach(image => {
    const path = resolveDocumentPath(image.getAttribute('src'), lesson.file);
    if (images['../' + path]) {
      image.src = images['../' + path];
      // Preserve author-supplied image links and adjacent captions. A separate
      // original-image label also works when the screenshot has no caption.
      const link = image.parentElement.tagName === 'A' ? image.parentElement : document.createElement('a');
      if (!link.contains(image)) { image.replaceWith(link); link.append(image); }
      link.href = image.src; link.target = '_blank'; link.rel = 'noopener'; link.classList.add('image-original');
      const caption = document.createElement('span'); caption.className = 'image-caption'; caption.textContent = '查看原图'; link.append(caption);
    }
    image.loading = 'lazy';
  });
  container.querySelectorAll('a').forEach(link => {
    const original = link.getAttribute('href') || '';
    // Published course links stay in this reader, including local previews.
    if (original.startsWith('https://chrichuang218.github.io/how-codex-works/#/')) { link.href = original.slice(original.indexOf('#')); return; }
    if (/^https?:/.test(original)) { link.target = '_blank'; link.rel = 'noopener'; return; }
    if (link.classList.contains('heading-anchor')) return;
    if (original.startsWith('#')) {
      const target = decodeURIComponent(original.slice(1));
      link.href = href(lesson.id, { section: resolveSection(lesson.id, target) });
      return;
    }
    const path = resolveDocumentPath(original.split('#')[0], lesson.file);
    const nextLesson = catalog.lessons.find(item => item.file === path);
    if (nextLesson) link.href = href(nextLesson.id, { section: resolveSection(nextLesson.id, original.split('#')[1]) });
    else if (path === 'README.md') link.href = '#/';
    else if (path === 'course/introduction.md') link.href = '#/guide';
    else if (files['../' + path]) {
      link.classList.add('source-link'); link.dataset.sourcePath = path;
      const location = fileLocations.get(path);
      const owner = location && preferredLesson(location.experiment.id, lesson.id)?.id;
      const view = location && ({ requestFile: 'request', outputItemsFile: 'output', upstreamFile: 'compare' }[location.kind] || 'raw');
      link.href = location ? evidenceHref(owner, location.experiment.id, location.index, view, view === 'raw' ? { kind: location.kind } : {}) : href(lesson.id, { file: path });
    } else if (images['../' + path]) link.href = images['../' + path];
    else if (path && !original.startsWith('mailto:')) link.href = repo + '/blob/main/' + path;
  });
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('code.language-mermaid')) return;
    const wrapper = document.createElement('div'); wrapper.className = 'code-panel';
    pre.replaceWith(wrapper);
    const toolbar = document.createElement('div'); toolbar.className = 'code-toolbar';
    toolbar.innerHTML = `<span>${esc(pre.querySelector('code')?.className.match(/language-(\S+)/)?.[1] || 'TEXT')}</span>${copyButton(pre.textContent)}`;
    wrapper.append(toolbar, pre);
  });
  highlightCode(container);
  container.querySelectorAll('table').forEach(table => { const wrapper = document.createElement('div'); wrapper.className = 'table-scroll'; wrapper.tabIndex = 0; table.replaceWith(wrapper); wrapper.append(table); });
  annotateTerms(container, glossary);
  outlines.set(lesson.id, headings);
}
async function ensurePage(lesson) {
  if (pageLoads.has(lesson.id)) return pageLoads.get(lesson.id);
  const pending = (async () => {
    const text = await loadFile(lesson.file);
    const page = document.createElement('section');
    const template = document.createElement('template');
    page.hidden = true; page.dataset.readerPage = lesson.id;
    if (lesson.id === 'introduction') {
      page.id = 'guide-page';
      template.innerHTML = `<article class="prose introduction" id="introduction">${DOMPurify.sanitize(marked.parse(text))}</article><section class="supplement" id="supplement-introduction" hidden aria-label="导读补充原始证据"></section>`;
    } else {
      page.id = 'chapter-' + lesson.id; page.className = 'chapter'; page.dataset.lesson = lesson.id;
      const markdown = text.replace(/^# [^\n]+\n/, '');
      template.innerHTML = `<header class="chapter-header">${chapterKicker(lesson)}<h1>${esc(lesson.title)}</h1><p class="chapter-subtitle">${esc(lesson.subtitle || '')}</p></header>${evidenceRail(lesson)}<article class="prose">${DOMPurify.sanitize(marked.parse(markdown))}</article>${workbenchShell(lesson)}`;
      // The Markdown navigation still works on GitHub; the site has a dedicated
      // previous/next control below the workbench.
      const last = template.content.querySelector('.prose > p:last-child');
      if (last && /上一章|下一章/.test(last.textContent)) last.remove();
    }
    // Rewrite local asset URLs while the Markdown is still inert. Detached
    // regular elements would already start fetching the original image src.
    decorateMarkdown(template.content.querySelector('.prose'), lesson);
    page.append(template.content);
    document.querySelector('#lesson-content').append(page);
    if (lesson.id !== 'introduction') {
      const state = { lessonId: lesson.id, ...initialWorkbenchPosition(lesson), loaded: false, version: 0 };
      states.set(lesson.id, state); updateWorkbenchChrome(state);
      evidenceObserver.observe(page.querySelector('[data-workbench]'));
    }
    if (lesson.id === '03-agent-loop') {
      const timeline = document.createElement('section'); timeline.id = 'agent-loop-timeline'; timeline.className = 'agent-loop-timeline';
      page.querySelector('.prose h2,.prose h3').before(timeline);
      outlines.get(lesson.id).unshift({ id: timeline.id, text: '真实请求时间线' });
      const { mountAgentLoopTimeline } = await import('./agent-loop-timeline.js');
      await mountAgentLoopTimeline(timeline, { loadJson, evidenceHref, experiment: experiments.find(item => item.id === '07-fix'), copyButton });
    }
    return page;
  })();
  pageLoads.set(lesson.id, pending);
  return pending;
}
function renderDiagrams(page) {
  if (diagramRenders.has(page)) return diagramRenders.get(page);
  const codes = page.querySelectorAll('code.language-mermaid');
  if (!codes.length) return;
  const pending = (async () => {
    const { default: mermaid } = await import('mermaid');
    codes.forEach(code => {
      const pre = code.parentElement;
      const div = document.createElement('div'); div.className = 'mermaid'; div.textContent = code.textContent;
      div.id = pre.id; div.dataset.passage = pre.dataset.passage;
      pre.replaceWith(div);
    });
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: 'Arial, Microsoft YaHei, sans-serif' });
    await mermaid.run({ nodes: page.querySelectorAll('.mermaid') });
    page.querySelectorAll('.mermaid').forEach(diagram => {
      const svg = diagram.querySelector('svg');
      if (!svg) return;
      const width = svg.viewBox.baseVal.width;
      if (width > 0) { svg.style.width = Math.ceil(width) + 'px'; svg.style.maxWidth = 'none'; svg.style.height = 'auto'; }
      const hint = document.createElement('p'); hint.className = 'diagram-hint'; hint.textContent = '图表保持原始字号，可在框内横向滚动。';
      diagram.before(hint); diagram.tabIndex = 0; diagram.setAttribute('role', 'region'); diagram.setAttribute('aria-label', '架构图，可横向滚动查看');
    });
  })();
  // A second route can enter this page while Mermaid is still importing.
  // Share the entire render, including its hints, rather than starting again.
  diagramRenders.set(page, pending);
  return pending;
}
function showPage(page, lesson) {
  const previousLesson = activeLesson;
  document.body.dataset.view = page ? 'reader' : 'home';
  document.querySelector('#home-view').hidden = Boolean(page);
  document.querySelector('#reader-view').hidden = !page;
  document.querySelectorAll('[data-reader-page]').forEach(node => node.hidden = node !== page);
  setActive(lesson?.id || '');
  syncSidebar(); refreshContinueReading();
  if (!page) renderTokenAnatomy();
  if (!page) { document.querySelector('.chapter-outline')?.remove(); return; }
  const group = catalog.groups.find(item => item.id === lesson.group);
  document.querySelector('.breadcrumb').innerHTML = `<a href="#/">学习路线</a><span aria-hidden="true">/</span>${group ? `<span>${esc(group.title)}</span><span aria-hidden="true">/</span>` : ''}<span aria-current="page">${lesson.id === 'introduction' ? '导读' : esc(lesson.title)}</span>`;
  const chapter = document.querySelector(`[data-nav-lesson="${lesson.id}"]`);
  let outline = chapter.querySelector('.chapter-outline');
  // Same-chapter routes keep the existing controls and their keyboard focus.
  if (!outline) {
    document.querySelector('.chapter-outline')?.remove();
    const headings = (outlines.get(lesson.id) || []).filter(heading => !page.querySelector(`#${CSS.escape(heading.id)}`)?.closest('details'));
    outline = document.createElement('nav'); outline.className = 'chapter-outline'; outline.id = 'outline-' + lesson.id; outline.setAttribute('aria-label', '本章目录');
    outline.innerHTML = headings.map(heading => `<a href="${href(lesson.id, { section: heading.id })}" data-section="${heading.id}" data-depth="${heading.depth || 0}" style="--section-depth:${heading.depth || 0}">${esc(heading.text)}</a>`).join('') + (lesson.id === 'introduction' ? '' : `<a href="${href(lesson.id, { section: 'workbench-' + lesson.id })}" data-section="workbench-${lesson.id}" data-depth="0" style="--section-depth:0">证据工作台</a>`);
    chapter.append(outline);
  }
  syncOutlineVisibility(lesson.id);
  if (previousLesson !== lesson.id) {
    const sidebar = document.querySelector('.course-sidebar');
    const chapterLink = chapter.querySelector('.chapter-row');
    const top = chapterLink.getBoundingClientRect().top;
    const visibleTop = sidebar.getBoundingClientRect().top + document.querySelector('.directory-search').offsetHeight;
    if (chapterLink.getClientRects().length && (top < visibleTop || top > innerHeight - 120)) sidebar.scrollTop += top - visibleTop - 12;
  }
  const index = catalog.lessons.indexOf(lesson);
  const previous = index > 0 ? catalog.lessons[index - 1] : null;
  const next = lesson.id === 'introduction' ? catalog.lessons[0] : catalog.lessons[index + 1];
  document.querySelector('.chapter-pagination').innerHTML = `${previous ? `<a data-direction="previous" href="${href(previous.id)}"><small>← 上一章</small><strong>${lessonNumber(previous)} ${esc(previous.title)}</strong></a>` : '<a data-direction="previous" href="#/guide"><small>← 阅读准备</small><strong>导读与实验准备</strong></a>'}${next ? `<a data-direction="next" href="${href(next.id)}"><small>下一章 →</small><strong>${lessonNumber(next)} ${esc(next.title)}</strong></a>` : '<a data-direction="next" href="#/"><small>回到学习路线 →</small><strong>复习各个主题</strong></a>'}`;
  if (lesson.id === 'introduction') document.querySelector('.chapter-pagination [data-direction="previous"]').outerHTML = '<a data-direction="previous" href="#/"><small>← 回到首页</small><strong>学习路线</strong></a>';
}
function updateWorkbenchChrome(state) {
  const host = document.querySelector(`[data-workbench="${state.lessonId}"]`);
  const experiment = experiments.find(item => item.id === state.experimentId);
  const select = host.querySelector('.experiment-select');
  if (![...select.options].some(option => option.value === experiment.id)) select.add(new Option(experiment.title + '（关联记录）', experiment.id));
  select.value = experiment.id;
  host.querySelector('.stage-select').innerHTML = experiment.stages.map((stage, index) => `<option value="${index}" ${index === state.stage ? 'selected' : ''}>${stageLabel(stage, experiment)}</option>`).join('');
  const interrupted = experiment.status === 'interrupted';
  const inputNote = experiment.id === '17-goal' ? '通过原生 Goal 入口设置目标，具体目标见请求中的 goal 包装及本章记录。'
    : ['16-agent-a', '16-agent-b'].includes(experiment.id) ? '由父任务委派，普通聊天输入为空。实际委派内容见请求中的 agent_message 及本章说明。'
    : '本记录没有普通聊天输入，触发方式见本章说明与原始记录。';
  const inputMarkup = experiment.prompt?.trim() ? `<div><span>你</span><p>${esc(experiment.prompt)}</p></div>` : `<p class="delegation-note">${inputNote}</p>`;
  const submissionMethod = experiment.submission?.method;
  const submissionLabel = { 'computer-use-desktop-composer': '输入框提交。', 'codex-app-create-thread': '跨任务工具提交；不能作为普通输入框的 Hook 信任对照。' }[submissionMethod];
  const reply = interrupted && !experiment.reply ? '本轮已中断，没有最终回复。单次模型完成事件不代表整个任务成功完成。' : experiment.reply || '本记录没有普通最终回复，可查看各阶段的模型输出和原生事件。';
  host.querySelector('.experiment-summary').innerHTML = `<p class="experiment-count">${experiment.stats.requests} 次正式模型请求${experiment.stats.prewarms ? ` + ${experiment.stats.prewarms} 次预热` : ''} · ${experiment.stats.toolCalls} 次外层工具调用${interrupted ? '<strong class="interrupted-badge">已中断</strong>' : ''}</p>${experiment.requestKind === 'compaction' ? '<p class="evidence-notice">原生压缩操作，没有普通聊天输入与最终回复。原始记录中可查看本地压缩事件。</p>' : `<details class="conversation"><summary>这次实验的输入与${interrupted ? '中断状态' : '回复'}</summary>${inputMarkup}<div><span>${interrupted || !experiment.reply ? '状态' : 'Codex'}</span><p>${esc(reply)}</p></div></details>`}`;
  if (submissionLabel) host.querySelector('.experiment-count').insertAdjacentHTML('afterend', `<p class="field-note" data-submission-method="${esc(submissionMethod)}">${esc(submissionLabel)}</p>`);
  if (experiment.coverage === 'text-progress-only') host.querySelector('.experiment-summary').insertAdjacentHTML('beforeend', '<p class="evidence-notice">本轮没有原生计划状态工具；记录中的清单属于文字进度。</p>');
  host.querySelector('[data-stage-prev]').disabled = state.stage === 0;
  host.querySelector('[data-stage-next]').disabled = state.stage === experiment.stages.length - 1;
  host.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === state.view); button.setAttribute('aria-pressed', String(button.dataset.view === state.view)); });
  host.dataset.experiment = experiment.id; host.dataset.stage = state.stage; host.dataset.view = state.view;
}
async function renderWorkbench(state, updateUrl = true) {
  const version = ++state.version;
  const expectedRoute = routeNumber;
  state.loaded = true;
  const host = document.querySelector(`[data-workbench="${state.lessonId}"]`);
  const experiment = experiments.find(item => item.id === state.experimentId);
  const stage = experiment.stages[state.stage];
  const content = host.querySelector('.workbench-content');
  updateWorkbenchChrome(state);
  host.setAttribute('aria-busy', 'true');
  releaseCopies(content);
  content.innerHTML = '<p class="loading-state">正在加载本次证据…</p>';
  try {
    const [request, completed, derived] = await Promise.all([loadJson(stage.requestFile), loadJson(stage.responseFile), stage.outputItemsFile ? loadJson(stage.outputItemsFile) : null]);
    if (version !== state.version) return;
    const response = completed.response || completed;
    const next = experiments.flatMap(item => item.stages.map((nextStage, index) => ({ experiment: item, stage: nextStage, index }))).filter(item => item.stage.previousResponseId === stage.responseId);
    host.querySelector('.request-metadata').innerHTML = `<details><summary>样本与响应信息</summary><p class="sample-scope">本记录仅说明当时配置下的行为；未记录的客户端版本不作推测。<a href="${esc(href(state.lessonId, { file: `evidence/desktop-lab/${experiment.id}/manifest.json` }))}">查看实验来源</a></p><dl><div><dt>请求时间</dt><dd>${esc(stage.requestTimestamp)}</dd></div><div><dt>model / generate</dt><dd><code>${esc(request.model)}</code> / ${has(request, 'generate') ? esc(request.generate) : '未显式设置'}</dd></div><div><dt>previous_response_id</dt><dd>${responseLink(request.previous_response_id, state.lessonId)}</dd></div><div><dt>本次 response.id</dt><dd><code>${esc(response.id || stage.responseId)}</code></dd></div><div><dt>后续响应引用</dt><dd>${next.length ? next.map(item => responseLink(item.stage.responseId, state.lessonId, item.experiment.id + ' / ' + item.stage.id)).join(' · ') : '当前记录中没有直接引用；后续上下文也可能通过历史重发接续。'}</dd></div></dl></details>`;
    if (state.view === 'request') { content.innerHTML = requestMarkup(request); openRequestFocus(content, requestFocus(request, state)); }
    else if (state.view === 'output') content.innerHTML = outputMarkup(derived, completed);
    else if (state.view === 'calls') {
      const markup = await callsMarkup(state, request, derived?.items || []);
      if (version !== state.version) { for (const match of markup.matchAll(/data-copy="(\d+)"/g)) textCopies.delete(Number(match[1])); return; }
      content.innerHTML = markup;
    }
    else if (state.view === 'compare') {
      const [upstream, clientText, upstreamText] = await Promise.all([loadJson(stage.upstreamFile), loadFile(stage.requestFile), loadFile(stage.upstreamFile)]);
      if (version !== state.version) return;
      content.innerHTML = `<p class="comparison-result">${canonical(request) === canonical(upstream) ? '本次客户端与上游快照的 JSON 字段和值一致。' : '本次客户端与上游快照存在差异，请按字段逐项核对。'}比较结果仅对应本次请求。</p><div class="compare-grid">${codePanel(clientText, '客户端 → CPA · 完整快照', 'data-client-raw')}${codePanel(upstreamText, 'CPA → 上游 · 完整快照', 'data-upstream-raw')}</div>`;
    } else {
      const available = [['requestFile', '客户端请求', stage.requestFile], ['outputItemsFile', '输出项（衍生）', stage.outputItemsFile], ['responseFile', '完成事件', stage.responseFile], ['eventsFile', '流式事件', stage.eventsFile], ['upstreamFile', '上游请求', stage.upstreamFile], ['compactionFile', '压缩记录', experiment.compactionFile], ['interruptionFile', '中断记录', experiment.interruptionFile], ['hookEventsFile', 'Hook 事件', experiment.hookEventsFile], ['rolloutEventsFile', '本地执行事件', experiment.rolloutEventsFile], ['fileObservationsFile', '文件变化与退出码', experiment.fileObservationsFile], ['auditFile', '证据核对', experiment.auditFile], ['manifestFile', '实验来源与脱敏', experiment.manifestFile]].filter(([, , path]) => path);
      const selected = available.find(([kind]) => kind === state.rawKind) || available[0];
      state.rawKind = selected[0];
      const text = await loadFile(selected[2]);
      if (version !== state.version) return;
      content.innerHTML = `<div class="raw-controls"><label>原始文件 <select class="raw-select" aria-label="选择原始记录">${available.map(([kind, label]) => `<option value="${kind}" ${kind === state.rawKind ? 'selected' : ''}>${label}</option>`).join('')}</select></label><button data-download="${esc(selected[2])}">下载文件 ↓</button></div><p class="source-path">${esc(selected[2])}</p><p class="field-note">${state.rawKind === 'outputItemsFile' ? '这是从流式事件提取的衍生输出项；原完成事件保留原样。' : state.rawKind === 'responseFile' && experiment.status === 'interrupted' ? '本轮用户任务已中断。这里的 response.completed 只证明对应模型响应结束。' : '公开快照已脱敏，完整内容如下；处理方式见实验来源说明。'}</p>${codePanel(text, selected[1] + ' · 文件全文', 'data-raw-content')}`;
    }
    if (version === state.version) {
      if (updateUrl && expectedRoute === routeNumber && activeLesson === state.lessonId) history.replaceState(null, '', workbenchHref(state));
      host.setAttribute('aria-busy', 'false'); host.dataset.ready = 'true';
    }
  } catch (error) {
    if (version !== state.version) return;
    console.error('证据加载失败', error);
    content.innerHTML = `<p class="error-state">${esc(error.message)}</p>`; host.setAttribute('aria-busy', 'false'); host.dataset.ready = 'error';
  }
}

async function buildRelations() {
  if (!relations) relations = Promise.all(experiments.flatMap(experiment => experiment.stages.map(async (stage, index) => {
    const [request, output] = await Promise.all([loadJson(stage.requestFile), stage.outputItemsFile ? loadJson(stage.outputItemsFile) : null]);
    return { experiment, stage, index, request, output: output?.items || [] };
  }))).then(rows => {
    const registry = new Map();
    for (const row of rows) {
      for (const [kind, items] of [['calls', row.output], ['results', row.request.input || []]]) items.forEach((item, itemIndex) => {
        if (!item.call_id || (kind === 'results' && !/call_output$/.test(item.type || '')) || (kind === 'calls' && !/call$/.test(item.type || ''))) return;
        if (!registry.has(item.call_id)) registry.set(item.call_id, { calls: [], results: [] });
        registry.get(item.call_id)[kind].push({ ...row, item, itemIndex });
      });
    }
    return registry;
  });
  return relations;
}
async function callsMarkup(state, request, output) {
  const registry = await buildRelations();
  const calls = output.filter(item => item.call_id && /call$/.test(item.type || ''));
  const inputs = (request.input || []).filter(item => item.call_id && isToolResult(item));
  const ids = [...new Set([...calls, ...inputs].map(item => item.call_id))];
  const focusedIds = new Set((calls.length ? calls : inputs).map(item => item.call_id));
  return `<p class="evidence-notice">用 <code>call_id</code> 对应模型调用与后续请求中的返回。同一结果多次发送时分别列出；外层脚本中的各条语句不单列为模型调用。</p>${ids.length ? ids.map(id => {
    const matches = registry.get(id) || { calls: [], results: [] };
    return `<section class="call-pair"><h4><code>${esc(id)}</code></h4><h5>模型提出的调用</h5>${matches.calls.length ? matches.calls.map(item => relatedItem(item, state, 'output', focusedIds.has(id))).join('') : '<p>输出项中未找到调用来源。</p>'}<h5>交回模型的结果</h5>${matches.results.length ? matches.results.map(item => relatedItem(item, state, 'request', focusedIds.has(id))).join('') : '<p>记录中未找到对应结果，尚不能确认执行成功。</p>'}</section>`;
  }).join('') : '<p class="empty-state">这个阶段没有提出新的工具调用，也没有输入工具结果。可选择前后请求继续观察。</p>'}`;
}
function relatedItem(item, state, view, open) {
  const lesson = preferredLesson(item.experiment.id, state.lessonId);
  return `<details class="related-item" ${open ? 'open' : ''}><summary>${esc(item.experiment.id)} / ${esc(item.stage.id)} · ${esc(item.item.name || item.item.type)}</summary><a class="related-source" href="${evidenceHref(lesson.id, item.experiment.id, item.index, view, { input: view === 'request' ? item.itemIndex : undefined })}">跳到对应${view === 'request' ? '请求输入' : '模型输出'} →</a>${codePanel(json(item.item), view === 'request' ? '完整工具结果项目' : '完整调用项目', `data-call-item="${esc(item.item.call_id)}"`)}</details>`;
}
async function openSupplement(lessonId, path) {
  const expectedRoute = routeNumber;
  const host = document.querySelector('#supplement-' + lessonId);
  if (!host) throw new Error('该位置没有补充证据区域。');
  host.hidden = false; host.setAttribute('aria-busy', 'true'); host.dataset.sourcePath = path; host.dataset.sourceRoute = String(expectedRoute);
  const text = await loadFile(path);
  if (host.dataset.sourcePath !== path || host.dataset.sourceRoute !== String(expectedRoute)) return;
  if (expectedRoute !== routeNumber) { host.hidden = true; host.setAttribute('aria-busy', 'false'); return; }
  host.hidden = false;
  releaseCopies(host);
  host.innerHTML = `<div class="reading-return">${returnReadingMarkup()}</div><div class="supplement-heading"><h3>补充原始证据</h3><button data-close-source>收起</button></div><p class="source-path">${esc(path)}</p><div class="source-actions"><button data-download="${esc(path)}">下载文件 ↓</button>${copyButton(location.href, '复制此位置链接')}</div>${codePanel(text, '公开文件全文 · 保留原结构', 'data-supplement-content')}`;
  host.setAttribute('aria-busy', 'false'); revealSection(host);
}

async function handleClick(event) {
  const term = event.target.closest('[data-term]');
  if (term) {
    const entry = glossary[Number(term.dataset.term)];
    const popover = document.querySelector('#term-definition');
    termOpener?.setAttribute('aria-expanded', 'false'); termOpener = term;
    popover.querySelector('strong').textContent = entry.term;
    popover.querySelector('p').textContent = entry.meaning;
    const link = popover.querySelector('a');
    const lesson = catalog.lessons.find(item => item.file === entry.source?.split('#')[0]);
    link.hidden = !lesson;
    if (lesson) { link.href = href(lesson.id, { section: resolveSection(lesson.id, entry.source?.split('#')[1]) }); link.textContent = entry.sourceLabel + ' →'; }
    popover.showPopover(); term.setAttribute('aria-expanded', 'true');
    const rect = term.getBoundingClientRect();
    popover.style.left = `${Math.max(12, Math.min(rect.left, document.documentElement.clientWidth - popover.offsetWidth - 12))}px`;
    popover.style.top = `${Math.max(76, Math.min(rect.bottom + 8, innerHeight - popover.offsetHeight - 12))}px`;
    popover.querySelector('[data-close-term]').focus({ preventScroll: true });
    return;
  }
  if (event.target.closest('[data-close-term]')) { document.querySelector('#term-definition').hidePopover(); termOpener?.focus({ preventScroll: true }); return; }
  const outlineToggle = event.target.closest('[data-toggle-outline]');
  if (outlineToggle) {
    event.preventDefault();
    const id = outlineToggle.dataset.toggleOutline;
    if (id !== activeLesson) return;
    if (collapsedOutlines.has(id)) collapsedOutlines.delete(id); else collapsedOutlines.add(id);
    syncOutlineVisibility(id);
    scrollSpy();
    return;
  }
  const anchor = event.target.closest('a');
  if (anchor?.closest('.prose,.agent-loop-timeline') && /[?&](experiment|file)=/.test(anchor.getAttribute('href') || '')) {
    evidenceReturn = currentPosition(); refreshReadingReturns();
  }
  if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && anchor?.getAttribute('href') === location.hash && location.hash.startsWith('#/')) {
    event.preventDefault(); await route(); return;
  }
  const copy = event.target.closest('[data-copy]');
  if (copy) { await copyText(textCopies.get(Number(copy.dataset.copy))); return; }
  const download = event.target.closest('[data-download]');
  if (download) {
    const path = download.dataset.download;
    const blob = URL.createObjectURL(new Blob([await loadFile(path)], { type: path.endsWith('.json') ? 'application/json' : 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = blob; link.download = path.split('/').at(-1); link.click(); setTimeout(() => URL.revokeObjectURL(blob), 1000); return;
  }
  if (event.target.closest('[data-close-source]')) { event.target.closest('.supplement').hidden = true; return; }
  if (sidebarOverlay() && event.target.closest('.course-sidebar a')) toggleMenu(false, false);
  const host = event.target.closest('[data-workbench]');
  if (!host) return;
  const state = states.get(host.dataset.workbench);
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.view) { state.view = button.dataset.view; await renderWorkbench(state); }
  else if (button.hasAttribute('data-stage-prev')) { state.stage--; state.explicitFocus = null; await renderWorkbench(state); }
  else if (button.hasAttribute('data-stage-next')) { state.stage++; state.explicitFocus = null; await renderWorkbench(state); }
  else if (button.hasAttribute('data-share')) await copyText(new URL(workbenchHref(state), location.href).href);
  else if (button.matches('.load-evidence')) await renderWorkbench(state);
  else if (button.hasAttribute('data-expand-inputs')) host.querySelectorAll('.trace-item,.content-block').forEach(details => details.open = true);
  else if (button.hasAttribute('data-collapse-inputs')) host.querySelectorAll('.trace-item,.content-block').forEach(details => details.open = false);
}
async function copyText(text) {
  const toast = document.querySelector('.toast');
  try { await navigator.clipboard.writeText(String(text)); toast.textContent = '已复制完整内容'; }
  catch { toast.textContent = '复制失败，请选中文字手动复制。'; }
  toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 1800);
}
function setActive(id) {
  activeLesson = id;
  document.querySelectorAll('[data-nav-lesson]').forEach(node => {
    const active = node.dataset.navLesson === id;
    node.classList.toggle('active', active);
    if (active) node.querySelector('a').setAttribute('aria-current', 'page'); else node.querySelector('a').removeAttribute('aria-current');
    const button = node.querySelector('[data-toggle-outline]');
    button.hidden = !active;
    if (!active) button.setAttribute('aria-expanded', 'false');
  });
  document.querySelector('.intro-link').classList.toggle('active', id === 'introduction');
}
async function filterNavigation() {
  const version = ++searchNumber;
  const query = document.querySelector('#chapter-search').value.trim();
  const results = document.querySelector('#search-results');
  const status = document.querySelector('#search-status');
  document.querySelector('#clear-search').hidden = !query;
  document.querySelector('#chapter-nav').hidden = Boolean(query);
  results.hidden = status.hidden = !query;
  if (!query) { results.innerHTML = ''; status.textContent = ''; return; }
  status.textContent = '正在搜索正文…';
  if (!searchIndex) searchIndex = Promise.all([{ id: 'introduction', file: 'course/introduction.md', title: '导读与实验准备' }, ...catalog.lessons].map(async lesson => {
    const text = await loadFile(lesson.file);
    const template = document.createElement('template');
    template.innerHTML = DOMPurify.sanitize(marked.parse(lesson.id === 'introduction' ? text : text.replace(/^# [^\n]+\n/, '')));
    const container = template.content;
    const last = container.lastElementChild;
    if (last?.matches('p') && /上一章|下一章/.test(last.textContent)) last.remove();
    return indexPassages(container, lesson, sectionIds).passages;
  })).then(rows => rows.flat()).catch(error => { searchIndex = null; throw error; });
  const matches = searchPassages(await searchIndex, query);
  if (version !== searchNumber) return;
  status.textContent = matches.length ? `找到 ${matches.length} 处匹配${matches.length > 80 ? '，先显示前 80 处，请增加关键词缩小范围' : ''}` : `没有找到“${query}”，试试术语或更短的关键词。`;
  results.innerHTML = matches.slice(0, 80).map(item => `<a class="search-result" href="${esc(href(item.lesson, { section: item.section || undefined, match: item.passage, q: query }))}"><span class="chapter-title">${esc(item.title)}</span><strong class="result-section">${esc(item.sectionTitle)}</strong><span class="result-context">${esc(item.excerpt)}</span></a>`).join('');
  document.querySelector('.course-sidebar').scrollTop = 0;
}
async function route() {
  saveReadingPosition();
  readingReady = false;
  clearTimeout(saveTimer);
  document.querySelector('#term-definition')?.hidePopover();
  document.querySelectorAll('.search-highlight').forEach(mark => mark.replaceWith(mark.textContent));
  document.querySelectorAll('.search-destination').forEach(node => node.classList.remove('search-destination'));
  const currentRoute = ++routeNumber;
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const requestedId = path.startsWith('lesson/') ? decodeURIComponent(path.slice(7)) : ['guide', 'intro', 'introduction'].includes(path) ? 'introduction' : '';
  let id = requestedId === '0' ? 'introduction' : has(catalog.legacyRoutes || {}, requestedId) ? catalog.legacyRoutes[requestedId] : requestedId;
  const sectionRedirect = !params.has('experiment') && !params.has('file') && catalog.sectionRedirects?.[`${id}:${params.get('section')}`];
  if (sectionRedirect) {
    id = sectionRedirect.lesson;
    params.set('section', sectionRedirect.section);
  }
  let lesson = catalog.lessons.find(item => item.id === id);
  const requestedExperiment = params.has('file')
    ? experiments.find(experiment => params.get('file').startsWith(`evidence/desktop-lab/${experiment.id}/`))?.id
    : params.get('experiment');
  if (requestedExperiment) {
    lesson = preferredLesson(requestedExperiment, id) || lesson;
    if (lesson) id = lesson.id;
  }
  if (sectionRedirect || id !== requestedId || (id === 'introduction' && path !== 'guide')) {
    if (params.get('section') === 'workbench-' + requestedId) params.set('section', 'workbench-' + id);
    else if (id !== requestedId && requestedId !== '0' && params.get('section')?.startsWith(requestedId + '-section-')) params.delete('section');
    history.replaceState(null, '', href(id, Object.fromEntries(params)));
  }
  if (sidebarOverlay()) toggleMenu(false, false);
  const main = document.querySelector('#main');
  if (!lesson && id !== 'introduction') {
    if (id) showToast('未找到该章节，已返回学习路线。');
    showPage(null); main.setAttribute('aria-busy', 'false');
    document.title = 'Codex 是如何工作的'; setDescription(catalog.description);
    window.scrollTo({ top: 0, behavior: 'instant' }); return;
  }
  if (id === 'introduction') lesson = { id: 'introduction', file: 'course/introduction.md', title: '导读与实验准备' };
  main.setAttribute('aria-busy', 'true');
  const page = await ensurePage(lesson);
  if (currentRoute !== routeNumber) return;
  showPage(page, lesson);
  document.title = lesson.title + ' · Codex 是如何工作的';
  setDescription(lesson.subtitle || catalog.description);
  await renderDiagrams(page);
  if (currentRoute !== routeNumber) return;
  main.setAttribute('aria-busy', 'false');
  readingReady = true;
  refreshReadingReturns();
  if (params.has('file')) { await openSupplement(id, params.get('file')); return; }
  if (params.has('experiment') && id !== 'introduction') {
    const state = states.get(id);
    const experiment = experiments.find(item => item.id === params.get('experiment'));
    if (!experiment) { showToast('未找到该实验记录。'); return; }
    state.experimentId = experiment.id;
    state.stage = Math.min(nonnegativeInteger(params.get('stage')) ?? 0, experiment.stages.length - 1);
    state.view = ['request', 'output', 'calls', 'compare', 'raw'].includes(params.get('view')) ? params.get('view') : 'request';
    state.rawKind = params.get('kind') || 'requestFile';
    const input = nonnegativeInteger(params.get('input'));
    const content = nonnegativeInteger(params.get('content'));
    state.explicitFocus = state.view === 'request' && input !== undefined && (!params.has('content') || content !== undefined) ? { input, ...(content === undefined ? {} : { content }) } : null;
    await renderWorkbench(state, false);
    if (currentRoute !== routeNumber) return;
    const host = document.querySelector(`[data-workbench="${id}"]`);
    if (state.explicitFocus) {
      const item = host.querySelector(`[data-item-path="input[${state.explicitFocus.input}]"]`);
      if (item) { revealSection(item); return; }
    }
    revealSection(host); return;
  }
  const match = params.get('match') && document.getElementById(params.get('match'));
  const section = params.get('section') && document.getElementById(params.get('section'));
  if (match && page.contains(match)) {
    match.classList.add('search-destination'); highlightPassage(match, params.get('q'));
    revealSection(match); match.tabIndex = -1; match.focus({ preventScroll: true });
  } else if (section && page.contains(section)) {
    revealSection(section);
    if (params.has('offset')) window.scrollBy({ top: Math.max(-200, Math.min(10000, Number(params.get('offset')) || 0)), behavior: 'instant' });
  } else window.scrollTo({ top: params.has('offset') ? Math.max(0, Math.min(10000, Number(params.get('offset')) || 0)) : 0, behavior: 'instant' });
  scrollSpy();
}
function revealSection(element) {
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) if (ancestor.tagName === 'DETAILS') ancestor.open = true;
  if (element.tagName === 'SUMMARY') element.parentElement.open = true;
  element.scrollIntoView({ block: 'start', behavior: 'instant' });
}
function showToast(text) { const toast = document.querySelector('.toast'); toast.textContent = text; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 2200); }
function scrollSpy() {
  document.querySelector('#back-top').classList.toggle('visible', scrollY > 400);
  const headings = [...document.querySelectorAll('.chapter-outline [data-section]')].map(link => document.getElementById(link.dataset.section)).filter(Boolean);
  // A short final section cannot reach the usual reading line at page bottom.
  const atBottom = scrollY > 0 && scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
  const current = headings.filter(node => node.getClientRects().length && node.getBoundingClientRect().top < (atBottom ? innerHeight : 170)).at(-1);
  document.querySelectorAll('.chapter-outline [data-section]').forEach(link => {
    const active = Boolean(current?.id) && link.dataset.section === current.id;
    link.classList.toggle('current', active);
    if (active) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
  });
}

async function start() {
  let glossaryText;
  [catalog, { experiments }, sectionIds, glossaryText] = await Promise.all([loadJson('course/catalog.json'), loadJson('evidence/desktop-lab/index.json'), loadJson('course/section-ids.json'), loadFile('GLOSSARY.md')]);
  glossary = glossaryEntries(DOMPurify.sanitize(marked.parse(glossaryText)));
  responseLocations = new Map(); fileLocations = new Map();
  for (const experiment of experiments) experiment.stages.forEach((stage, index) => {
    if (!responseLocations.has(stage.responseId)) responseLocations.set(stage.responseId, []);
    responseLocations.get(stage.responseId).push({ experiment, stage, index });
    for (const kind of ['requestFile', 'responseFile', 'eventsFile', 'upstreamFile', 'outputItemsFile']) if (stage[kind]) fileLocations.set(stage[kind], { experiment, index, kind });
  });
  shell();
  addEventListener('hashchange', () => route().catch(error => { console.error(error); showToast(error.message); }));
  await route();
  let queued = false;
  addEventListener('scroll', () => {
    if (!queued) { queued = true; requestAnimationFrame(() => { scrollSpy(); queued = false; }); }
    clearTimeout(saveTimer); saveTimer = setTimeout(saveReadingPosition, 350);
  }, { passive: true });
  addEventListener('pagehide', saveReadingPosition);
}
start().catch(error => {
  console.error('教程加载失败', error);
  if (!document.querySelector('#main')) document.querySelector('#app').innerHTML = '<main id="main"></main>';
  const main = document.querySelector('#main');
  main.setAttribute('aria-busy', 'false');
  main.innerHTML = `<p class="error-state">教程加载失败：${esc(error.message)}</p>`;
});
