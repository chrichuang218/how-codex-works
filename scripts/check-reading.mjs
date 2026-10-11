import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const catalog = JSON.parse(await readFile('course/catalog.json', 'utf8'));
const sectionIds = JSON.parse(await readFile('course/section-ids.json', 'utf8'));
const baseline = JSON.parse(await readFile('docs/section-baseline.json', 'utf8'));
const route = (lesson, params = {}) => (lesson === 'introduction' ? '#/guide' : '#/lesson/' + lesson) + (Object.keys(params).length ? '?' + new URLSearchParams(params) : '');

async function settled(page, lesson) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(lesson => {
    const active = document.querySelector('[data-reader-page]:not([hidden])');
    return document.querySelector('#main')?.getAttribute('aria-busy') === 'false' && active?.dataset.readerPage === lesson;
  }, lesson);
}

export async function checkDiagramReentry(page, url, label = 'local') {
  const probe = await page.context().browser().newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  probe.on('pageerror', error => errors.push(error.message));
  probe.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  probe.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  let releaseModule;
  const moduleGate = new Promise(resolve => { releaseModule = resolve; });
  const moduleUrl = /\/mermaid[^/]*\.js(?:\?|$)/;
  try {
    await probe.goto(url); await probe.locator('#main[aria-busy="false"]').waitFor();
    await probe.route(moduleUrl, async request => { await moduleGate; await request.continue(); });
    const pendingModule = probe.waitForRequest(moduleUrl, { timeout: 10_000 });
    await probe.evaluate(hash => { location.hash = hash; }, route('05-context'));
    const requested = await pendingModule;
    const sourceId = await probe.locator('#chapter-05-context code.language-mermaid').evaluate(node => node.parentElement.id);
    const section = sectionIds['05-context']['从摘要到真正替换历史'];
    await probe.locator(`.chapter-outline a[data-section="${section}"]`).click();
    await probe.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    releaseModule();
    await settled(probe, '05-context'); await probe.waitForLoadState('networkidle');
    const result = await probe.locator('#chapter-05-context').evaluate((chapter, section) => ({
      diagramCount: chapter.querySelectorAll('.mermaid').length,
      svgCount: chapter.querySelectorAll('.mermaid > svg').length,
      hintCount: chapter.querySelectorAll('.diagram-hint').length,
      diagramId: chapter.querySelector('.mermaid')?.id,
      passageId: chapter.querySelector('.mermaid')?.dataset.passage,
      anchorTop: document.getElementById(section).getBoundingClientRect().top,
      hash: location.hash,
    }), section);
    await mkdir('work', { recursive: true });
    await writeFile(`work/reading-diagram-reentry-${label}.json`, JSON.stringify({ delayedModule: requested.url(), sourceId, ...result, errors }, null, 2) + '\n');
    await probe.screenshot({ path: `work/reading-diagram-reentry-${label}.png`, animations: 'disabled' });
    assert.equal(result.diagramCount, 1, 'Re-entering during Mermaid import must not duplicate the diagram');
    assert.equal(result.svgCount, 1);
    assert.equal(result.hintCount, 1, 'Re-entering during Mermaid import must not duplicate its scroll hint');
    assert.equal(result.diagramId, sourceId);
    assert.equal(result.passageId, sourceId, 'The rendered diagram must retain the source paragraph anchor');
    assert.equal(result.hash, route('05-context', { section }));
    assert.ok(result.anchorTop >= 60 && result.anchorTop < 200, 'The last clicked section must win after diagram rendering');
    assert.deepEqual(errors, [], 'Diagram re-entry caused a browser or resource error');
    console.log(`Diagram re-entry checks passed (${label}): delayed Mermaid import, real section click, one diagram/SVG/hint, stable passage ID and correct final anchor.`);
  } finally {
    releaseModule();
    await probe.unrouteAll({ behavior: 'wait' });
    await probe.close();
  }
}

export async function checkReaderLayout(page, url, label = 'local') {
  await mkdir('work', { recursive: true });
  const cases = [], failures = [], observedKinds = new Set();
  for (const width of [2560, 1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const focus of [false, true]) {
      for (const lesson of ['01-request', 'introduction']) {
        await page.goto(url + route(lesson)); await settled(page, lesson);
        if (await page.locator('#focus-toggle').getAttribute('aria-pressed') !== String(focus)) await page.locator('#focus-toggle').click();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        const geometry = await page.evaluate(lesson => {
          const article = document.querySelector(`[data-reader-page="${lesson}"]`);
          const reader = article.closest('.reader-page');
          const prose = article.querySelector('.prose');
          const blocks = [];
          const collect = (kind, nodes) => {
            for (const node of nodes) if (node?.getClientRects().length) {
              const box = node.getBoundingClientRect();
              blocks.push({ kind, id: node.id, left: box.left, width: box.width,
                ...(kind === 'table' ? { clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight } : {}) });
            }
          };
          collect('breadcrumb', [reader.querySelector('.breadcrumb')]);
          collect('chapter-header', [article.querySelector('.chapter-header')]);
          // Compare outer block edges. Quote padding, code padding, and list
          // markers are deliberately outside this alignment contract.
          for (const [kind, selector] of Object.entries({
            'guide-title': ':scope > h1', paragraph: ':scope > p', heading: ':scope > h2',
            blockquote: ':scope > blockquote', code: ':scope > .code-panel',
            image: ':scope > p > .image-original, :scope > .image-original',
            table: ':scope > .table-scroll', details: ':scope > details', list: ':scope > ul, :scope > ol',
          })) collect(kind, prose.querySelectorAll(selector));
          collect('workbench', article.querySelectorAll(':scope > .workbench'));
          collect('pagination', [reader.querySelector('.chapter-pagination')]);
          return { readerLeft: reader.getBoundingClientRect().left, blocks, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
        }, lesson);
        cases.push({ width, focus, lesson, ...geometry });
        for (const block of geometry.blocks) {
          observedKinds.add(block.kind);
          const delta = block.left - geometry.readerLeft;
          if (Math.abs(delta) > 1) failures.push(`${width}px ${focus ? 'focus' : 'normal'} ${lesson} ${block.kind}: left ${block.left}, reader ${geometry.readerLeft}, delta ${delta}`);
          if (block.kind === 'table') {
            if (block.scrollHeight > block.clientHeight) failures.push(`${width}px ${focus ? 'focus' : 'normal'} ${lesson} table: needless vertical scroll ${block.scrollHeight} > ${block.clientHeight}`);
            if (width >= 1440 && lesson === '01-request' && block === geometry.blocks.find(item => item.kind === 'table') && block.scrollWidth > block.clientWidth) failures.push(`${width}px ${focus ? 'focus' : 'normal'} first input table: needless horizontal scroll ${block.scrollWidth} > ${block.clientWidth}`);
          }
        }
        if (geometry.overflow) failures.push(`${width}px ${focus ? 'focus' : 'normal'} ${lesson}: horizontal page overflow`);
        await page.screenshot({ path: `work/reading-layout-${lesson}-${width}-${focus ? 'focus' : 'normal'}-${label}.png`, animations: 'disabled' });
      }
    }
  }
  await writeFile(`work/reading-layout-${label}.json`, JSON.stringify({ url, cases, failures }, null, 2) + '\n');
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (await page.locator('#focus-toggle').getAttribute('aria-pressed') === 'true') await page.locator('#focus-toggle').click();
  for (const kind of ['breadcrumb', 'chapter-header', 'guide-title', 'paragraph', 'heading', 'blockquote', 'code', 'image', 'table', 'details', 'workbench', 'pagination']) assert.ok(observedKinds.has(kind), 'Layout coverage is missing ' + kind);
  assert.equal(failures.length, 0, `${failures.length} reader layout failures:\n` + failures.slice(0, 8).join('\n'));
  assert.equal(await page.locator('#introduction a[href="https://github.com/router-for-me/CLIProxyAPI/blob/main/README_CN.md"]').getAttribute('target'), '_blank', 'An external GitHub document must still open separately');
  await page.goto(url + route('03-agent-loop')); await settled(page, '03-agent-loop');
  const timelineLink = page.locator('#chapter-03-agent-loop .prose > p').getByRole('link', { name: '时间线', exact: true });
  assert.equal(await timelineLink.getAttribute('href'), route('03-agent-loop', { section: 'agent-loop-timeline' }), 'The published chapter link must become a local reader route');
  assert.notEqual(await timelineLink.getAttribute('target'), '_blank');
  const original = new URL(page.url()), pageCount = page.context().pages().length;
  await timelineLink.click();
  await page.waitForURL(destination => destination.origin === original.origin && destination.pathname === original.pathname && destination.hash === route('03-agent-loop', { section: 'agent-loop-timeline' }));
  await settled(page, '03-agent-loop');
  assert.equal(page.context().pages().length, pageCount, 'The timeline link must not open another page');
  assert.ok(await page.locator('#agent-loop-timeline').evaluate(node => node.getBoundingClientRect().top >= 60 && node.getBoundingClientRect().top < 200), 'The same-page link must reveal the timeline');
  await checkDiagramReentry(page, url, label);
  const termViewports = [];
  for (const width of [375, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(url + route('01-request')); await settled(page, '01-request');
    const termId = await page.locator('#chapter-01-request .prose > p .term-trigger').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0]?.dataset.term);
    assert.ok(termId !== undefined, 'The narrow-screen check needs a real paragraph term');
    const term = page.locator(`#chapter-01-request .term-trigger[data-term="${termId}"]`);
    await term.scrollIntoViewIfNeeded(); await term.press('Enter');
    await page.locator('#term-definition:popover-open').waitFor();
    const box = await page.locator('#term-definition').evaluate(node => {
      const rect = node.getBoundingClientRect();
      const actions = document.querySelector('.header-actions').getBoundingClientRect();
      const brand = document.querySelector('.brand').getBoundingClientRect();
      return { innerWidth, clientWidth: document.documentElement.clientWidth, left: rect.left, right: rect.right, width: rect.width, overflowY: getComputedStyle(node).overflowY,
        actionsLeft: actions.left, actionsRight: actions.right, brandRight: brand.right };
    });
    termViewports.push(box);
    await page.screenshot({ path: `work/reading-term-viewport-${width}-${label}.png`, animations: 'disabled' });
    assert.ok(box.left >= 11 && box.right <= box.clientWidth - 11, 'The term explanation must keep both viewport gutters: ' + JSON.stringify(box));
    assert.ok(box.actionsLeft >= 0 && box.actionsRight <= box.clientWidth + 1, 'Header actions must stay inside the visible viewport: ' + JSON.stringify(box));
    assert.ok(box.brandRight <= box.actionsLeft + 1, 'The brand and header actions must not overlap: ' + JSON.stringify(box));
    assert.ok(['auto', 'scroll'].includes(box.overflowY), 'Long term definitions must remain scrollable');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#term-definition:popover-open').count(), 0);
    assert.ok(await term.evaluate(node => node === document.activeElement), 'Escape must restore the original term focus on a narrow screen');
  }
  await writeFile(`work/reading-term-viewports-${label}.json`, JSON.stringify(termViewports, null, 2) + '\n');
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log(`Reader layout checks passed (${label}): ${cases.length} chapter/guide scenarios at 2560px, 1440px and 390px, normal/focus mode; shared outer left edge; no needless table scrollbars or page overflow; same-page timeline/external GitHub links; 375px/390px/320px header and term bounds, scrolling and Escape focus.`);
}

export async function checkWorkbenchDefaults(page, url, label = 'local') {
  const { experiments } = JSON.parse(await readFile('evidence/desktop-lab/index.json', 'utf8'));
  const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  const probe = await context.newPage(), records = [], errors = [];
  probe.on('pageerror', error => errors.push(error.message));
  probe.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  probe.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  const sources = async (id, index) => {
    const experiment = experiments.find(item => item.id === id), stage = experiment.stages[index];
    return { experiment, stage, request: JSON.parse(await readFile(stage.requestFile, 'utf8')), output: JSON.parse(await readFile(stage.outputItemsFile, 'utf8')).items };
  };
  const ready = async (lesson, expected) => {
    await probe.waitForFunction(({ lesson, expected }) => {
      const host = document.querySelector(`[data-workbench="${lesson}"]`);
      return host?.dataset.ready === 'true' && host.getAttribute('aria-busy') === 'false' && (!expected || Object.entries(expected).every(([key, value]) => host.dataset[key] === String(value)));
    }, { lesson, expected });
    return probe.locator(`[data-workbench="${lesson}"]`);
  };
  const open = async (lesson, params = {}) => {
    await probe.goto(url + route(lesson, params)); await settled(probe, lesson);
    await probe.locator(`[data-workbench="${lesson}"]`).scrollIntoViewIfNeeded();
    return ready(lesson);
  };
  const opened = host => host.evaluate(node => ({
    items: [...node.querySelectorAll('.trace-item[open]')].map(item => item.dataset.itemPath),
    content: [...node.querySelectorAll('.content-block[open]')].map(item => item.dataset.contentPath),
  }));
  const expectOpen = async (host, items, content, message) => assert.deepEqual(await opened(host), { items, content }, message);
  async function verifyItems(host, expected, prefix) {
    const rendered = await host.locator(`.trace-item[data-item-path^="${prefix}["]`).evaluateAll(nodes => nodes.map(node => ({
      original: JSON.parse(node.querySelector(':scope > .trace-item-body > .raw-details pre').textContent),
      content: [...node.querySelectorAll('[data-full-content]')].map(block => block.textContent),
    })));
    assert.deepEqual(rendered.map(item => item.original), expected, prefix + ': folding must preserve complete original objects and order');
    expected.forEach((item, index) => assert.deepEqual(rendered[index].content, (item.content || []).map(block => typeof block.text === 'string' ? block.text : JSON.stringify(block, null, 2)), prefix + ': complete content text changed'));
  }
  async function verifyCalls(host, request, output) {
    const calls = output.filter(item => /call$/.test(item.type || '') && item.call_id);
    const incoming = request.input.filter(item => /call_output$/.test(item.type || '') && item.call_id);
    const focused = new Set((calls.length ? calls : incoming).map(item => item.call_id));
    const pairs = await host.locator('.call-pair').evaluateAll(nodes => nodes.map(node => ({ id: node.querySelector('h4 code').textContent, open: [...node.querySelectorAll('.related-item')].map(item => item.open) })));
    assert.deepEqual(pairs.map(pair => pair.id).sort(), [...new Set([...calls, ...incoming].map(item => item.call_id))].sort(), 'Calls view must render every current call/result identity exactly once');
    for (const pair of pairs) assert.ok(pair.open.length && pair.open.every(value => value === focused.has(pair.id)), pair.id + ': current calls/results should open and historical pairs should close');
    return pairs;
  }
  const fixedDefaults = {
    '01-request': ['01-hello', 1, 'request'], '08-memory': ['12-memory-read', 1, 'request'],
    '09-mcp': ['13-mcp', 2, 'request'], '14-streaming': ['07-fix', 4, 'raw'], '15-architecture': ['07-fix', 2, 'output'],
  };
  try {
    await mkdir('work', { recursive: true });
    for (const lesson of catalog.lessons) {
      const target = lesson.readingGuide.targets[0], host = await open(lesson.id);
      const actual = await host.evaluate(node => ({ experiment: node.dataset.experiment, stage: Number(node.dataset.stage), view: node.dataset.view }));
      records.push({ lesson: lesson.id, ...actual, ...await opened(host) });
      assert.deepEqual(actual, { experiment: target.experiment, stage: target.stage, view: target.view }, lesson.id + ': default must follow the teaching target');
      if (fixedDefaults[lesson.id]) assert.deepEqual(Object.values(actual), fixedDefaults[lesson.id], lesson.id + ': the chapter must retain its intended evidence entry');
      const source = await sources(actual.experiment, actual.stage);
      assert.ok(!source.stage.prewarm, lesson.id + ': a normal chapter entry must not start on prewarm');
      if (actual.view === 'request') {
        const targets = lesson.readingGuide.targets.filter(item => item.experiment === actual.experiment && item.stage === actual.stage && item.view === 'request' && item.input !== undefined);
        assert.ok(targets.length, lesson.id + ': curated default inputs need an explicit target');
        const inputs = [...new Set(targets.map(item => item.input))].sort((a, b) => a - b).map(index => `input[${index}]`);
        const content = targets.filter(item => item.content !== undefined).sort((a, b) => a.input - b.input || a.content - b.content).map(item => `input[${item.input}].content[${item.content}]`);
        await expectOpen(host, inputs, [...new Set(content)], lesson.id + ': only curated request inputs/content should open');
        await verifyItems(host, source.request.input, 'input');
        if (lesson.id === '01-request') await expectOpen(host, ['input[5]', 'input[6]'], ['input[5].content[1]', 'input[6].content[0]'], 'The first chapter compares context with the user greeting, not input[4] orchestration');
        if (['08-memory', '09-mcp'].includes(lesson.id)) await expectOpen(host, ['input[0]'], [], lesson.id + ': the observed tool result is the entry point');
      } else if (actual.view === 'output') {
        const visible = source.output.flatMap((item, index) => item.type === 'message' || /call$/.test(item.type || '') ? [index] : []);
        await expectOpen(host, visible.map(index => `output[${index}]`), visible.flatMap(index => (source.output[index].content || []).map((_, block) => `output[${index}].content[${block}]`)), lesson.id + ': reasoning must stay folded while messages/calls open');
        await verifyItems(host, source.output, 'output');
      } else if (actual.view === 'calls') await verifyCalls(host, source.request, source.output);
      else {
        assert.equal(await host.locator('.raw-select').inputValue(), 'eventsFile', 'The streaming chapter starts with actual streamed events');
        // Windows checkout uses CRLF; the Pages build reads the same Git blob as LF.
        assert.equal((await host.locator('[data-raw-content]').textContent()).replace(/\r\n/g, '\n'), (await readFile(source.stage.eventsFile, 'utf8')).replace(/\r\n/g, '\n'), 'Raw event text must match apart from checkout line endings');
      }
    }
    // A fresh home entry must use the same two-input comparison, not treat the
    // first target as an explicit one-input bookmark.
    await probe.goto(url); await probe.reload(); await probe.locator('[data-hello-request]').click();
    let host = await ready('01-request', { experiment: '01-hello', stage: 1, view: 'request' });
    await expectOpen(host, ['input[5]', 'input[6]'], ['input[5].content[1]', 'input[6].content[0]'], 'The home request entry must share chapter defaults');
    await host.locator('[data-content-path="input[5].content[1]"] > summary').click();
    await host.locator('[data-item-path="input[5]"] > summary').click();
    await host.locator('[data-item-path="input[4]"] > summary').click();
    await host.locator('[data-content-path="input[4].content[0]"] > summary').click();
    const manual = await opened(host);
    assert.deepEqual(manual, { items: ['input[4]', 'input[6]'], content: ['input[4].content[0]', 'input[6].content[0]'] }, 'Manual clicks must actually open input[4] and close input[5]');
    await probe.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await probe.waitForFunction(() => scrollY === 0); await host.scrollIntoViewIfNeeded();
    await probe.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await opened(host), manual, 'Scrolling must not replace the reader\'s manual disclosure choices');
    await probe.screenshot({ path: `work/workbench-manual-disclosure-${label}.png`, animations: 'disabled' });

    host = await open('01-request', { experiment: '01-hello', stage: '1', view: 'request', input: '4', content: '0' });
    await expectOpen(host, ['input[4]'], ['input[4].content[0]'], 'Explicit bookmarks take priority over chapter defaults');
    for (const view of ['output', 'request']) { await host.locator(`[data-view="${view}"]`).click(); host = await ready('01-request', { view }); }
    await expectOpen(host, ['input[4]'], ['input[4].content[0]'], 'Returning to request view must retain explicit focus');
    await host.locator('[data-share]').click();
    const share = await probe.evaluate(() => navigator.clipboard.readText());
    const shareParams = new URLSearchParams(share.split('?')[1]);
    assert.equal(shareParams.get('input'), '4'); assert.equal(shareParams.get('content'), '0');
    await probe.reload(); host = await ready('01-request', { experiment: '01-hello', stage: 1, view: 'request' });
    await expectOpen(host, ['input[4]'], ['input[4].content[0]'], 'Refreshing a shared input/content bookmark must keep its exact focus');
    await verifyItems(host, (await sources('01-hello', 1)).request.input, 'input');
    host = await open('01-request', { experiment: '01-hello', stage: '1', view: 'request', input: '5' });
    await expectOpen(host, ['input[5]'], [], 'An input-only bookmark must not inherit a curated content block');

    host = await open('03-agent-loop', { experiment: '07-fix', stage: '0', view: 'request', input: '0', content: '0' });
    await expectOpen(host, ['input[0]'], ['input[0].content[0]'], 'Zero is a valid explicit input and content index');
    await host.locator('[data-share]').click();
    const zeroShare = new URLSearchParams((await probe.evaluate(() => navigator.clipboard.readText())).split('?')[1]);
    assert.equal(zeroShare.get('input'), '0'); assert.equal(zeroShare.get('content'), '0');
    await host.locator('.stage-select').selectOption('1'); host = await ready('03-agent-loop', { stage: 1, view: 'request' });
    await expectOpen(host, ['input[0]'], [], 'A pure tool-return request opens its result after clearing old content focus');
    assert.equal(new URLSearchParams(probe.url().split('?')[1]).has('input'), false, 'Changing stages must clear explicit focus');
    await host.locator('[data-view="calls"]').click(); host = await ready('03-agent-loop', { stage: 1, view: 'calls' });
    let source = await sources('07-fix', 1);
    const pairs = await verifyCalls(host, source.request, source.output);
    assert.ok(pairs.some(pair => pair.open.every(Boolean)) && pairs.some(pair => pair.open.every(value => !value)), 'The fixture must compare a new call with an older incoming result');
    await host.locator('.stage-select').selectOption('2'); host = await ready('03-agent-loop', { stage: 2, view: 'calls' });
    source = await sources('07-fix', 2); await verifyCalls(host, source.request, source.output);
    host = await open('09-mcp', { experiment: '13-mcp', stage: '2', view: 'calls' });
    source = await sources('13-mcp', 2); assert.equal(source.output.some(item => /call$/.test(item.type || '')), false);
    await verifyCalls(host, source.request, source.output);

    host = await open('05-context', { experiment: '10-compaction', stage: '0', view: 'request' });
    await expectOpen(host, [], [], 'Mixed history without a matching target or prompt must not guess which tools/messages to expand');
    await verifyItems(host, (await sources('10-compaction', 0)).request.input, 'input');
    host = await open('08-memory');
    await host.locator('.experiment-select').selectOption('12-memory-write'); host = await ready('08-memory', { experiment: '12-memory-write', stage: 0, view: 'request' });
    await expectOpen(host, ['input[0]'], ['input[0].content[0]'], 'An untargeted experiment falls back to its exact user prompt');
    const promptSource = await sources('12-memory-write', 0);
    assert.equal(promptSource.request.input[0].role, 'user');
    assert.equal(promptSource.request.input[0].content[0].text.trim(), promptSource.experiment.prompt.trim());
    host = await open('12-multi-agent');
    for (const experiment of ['16-agent-a', '16-agent-b']) {
      await host.locator('.experiment-select').selectOption(experiment); host = await ready('12-multi-agent', { experiment, stage: 1, view: 'request' });
      assert.ok(!(await sources(experiment, 1)).stage.prewarm);
      await expectOpen(host, ['input[18]'], ['input[18].content[0]'], experiment + ': switching experiments must skip prewarm and reveal the inherited task');
    }
    assert.deepEqual(errors, [], 'Workbench defaults caused browser/resource failures');
    console.log(`Workbench defaults passed (${label}): 16 semantic chapter entries; first chapter/home comparison; explicit/zero-index share and refresh; manual disclosure persistence; prompt/mixed-history/pure-result cases; current versus historical calls; non-prewarm experiment switching; complete source objects/text.`);
  } finally {
    await mkdir('work', { recursive: true });
    await writeFile(`work/workbench-defaults-${label}.json`, JSON.stringify({ url, records, errors }, null, 2) + '\n');
    await context.close();
  }
}

export async function checkReading(page, url, label = 'local') {
  await checkWorkbenchDefaults(page, url, label);
  await checkReaderLayout(page, url, label);
  await mkdir('work', { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url);
  await page.locator('#main[aria-busy="false"]').waitFor();
  if (await page.locator('html').evaluate(node => node.classList.contains('dark'))) await page.locator('#theme-toggle').click();
  const noOverflow = async name => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, name + ': page overflows horizontally');

  // The baseline stores what old URLs meant before the reorganization. Check
  // actual rendered text, rather than accepting a registered but missing ID.
  const anchors = [];
  for (const previous of process.argv.includes('--features-only') ? [] : baseline.sections) {
    const migration = catalog.sectionRedirects?.[`${previous.lesson}:${previous.section}`];
    const target = migration || previous;
    const expectedTitles = Object.entries(sectionIds[target.lesson] || {}).filter(([, id]) => id === target.section).map(([title]) => title);
    assert.ok(expectedTitles.length, previous.section + ': missing registered destination');
    await page.goto(url + route(previous.lesson, { section: previous.section }));
    await settled(page, target.lesson);
    assert.equal(new URL(page.url()).hash, route(target.lesson, { section: target.section }), previous.section + ': wrong section destination');
    const heading = page.locator(`[id="${target.section}"]`);
    assert.equal(await heading.count(), 1, previous.section + ': missing or duplicate rendered destination');
    await heading.waitFor({ state: 'visible' });
    const title = await heading.evaluate(node => { const clone = node.cloneNode(true); clone.querySelectorAll('.heading-anchor').forEach(anchor => anchor.remove()); return clone.textContent.trim(); });
    assert.ok(expectedTitles.includes(title), `${previous.section}: landed on unrelated text ${JSON.stringify(title)}`);
    if (!migration && expectedTitles.length === 1 && expectedTitles[0] === previous.title) assert.equal(title, previous.title);
    assert.ok(await heading.evaluate(node => { for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.open) return false; return node.getBoundingClientRect().top < innerHeight; }), previous.section + ': bookmark is hidden or below the viewport');
    anchors.push({ from: `${previous.lesson}:${previous.section}`, before: previous.title, lesson: target.lesson, section: target.section, title });
  }
  await writeFile(`work/reading-anchors-${label}.json`, JSON.stringify({ baseline: baseline.commit, anchors }, null, 2) + '\n');

  let guidedTargets = 0;
  for (const lesson of catalog.lessons) {
    await page.goto(url + route(lesson.id)); await settled(page, lesson.id);
    const headings = await page.locator(`#chapter-${lesson.id} .prose`).evaluate(container => [...container.querySelectorAll('h2,h3,h4,h5,h6,details > summary')]
      .filter(node => !node.closest('.agent-loop-timeline') && (node.tagName !== 'SUMMARY' || node.textContent.trim().startsWith('深入')))
      .map(node => { const clone = node.cloneNode(true); clone.querySelectorAll('.heading-anchor').forEach(anchor => anchor.remove()); return { id: node.id, title: clone.textContent.trim() }; }));
    assert.equal(new Set(headings.map(item => item.id)).size, headings.length, lesson.id + ': duplicate heading IDs');
    for (const heading of headings) assert.equal(sectionIds[lesson.id]?.[heading.title], heading.id, lesson.id + ': a current heading has no explicit stable ID: ' + heading.title);
    const links = page.locator(`#chapter-${lesson.id} .reading-targets a`);
    assert.equal(await links.count(), lesson.readingGuide.targets.length, lesson.id + ': missing reading target');
    for (const [index, target] of lesson.readingGuide.targets.entries()) {
      const link = links.nth(index);
      const href = await link.getAttribute('href');
      const params = new URLSearchParams(href.split('?')[1]);
      for (const field of ['experiment', 'stage', 'view', 'input', 'content', 'kind']) {
        if (target[field] !== undefined) assert.equal(params.get(field), String(target[field]), `${lesson.id}/${target.label}: dropped ${field}`);
      }
      await link.click();
      await page.waitForFunction(({ lesson, target, hash }) => {
        const host = document.querySelector(`[data-workbench="${lesson}"]`);
        return location.hash === hash && host?.dataset.experiment === target.experiment && host.dataset.stage === String(target.stage)
          && host.dataset.view === (target.view || 'request') && host.dataset.ready === 'true' && host.getAttribute('aria-busy') === 'false';
      }, { lesson: lesson.id, target, hash: href });
      if (target.kind) assert.equal(await page.locator(`[data-workbench="${lesson.id}"] .raw-select`).inputValue(), target.kind, `${lesson.id}/${target.label}: opened wrong evidence file`);
      if (target.input !== undefined) await page.waitForFunction(({ lesson, index }) => document.querySelector(`[data-workbench="${lesson}"] [data-item-path="input[${index}]"]`)?.open, { lesson: lesson.id, index: target.input });
      if (target.content !== undefined) assert.ok(await page.locator(`[data-workbench="${lesson.id}"] [data-content-path="input[${target.input}].content[${target.content}]"]`).evaluate(node => node.open));
      guidedTargets++;
    }
  }

  await page.goto(url + route('02-tools'));
  await settled(page, '02-tools');
  await page.locator('#chapter-search').fill('call_id');
  const first = page.locator('#search-results a.search-result').first();
  await first.waitFor();
  for (const selector of ['.chapter-title', '.result-section', '.result-context']) assert.ok((await first.locator(selector).innerText()).trim(), selector + ': missing search context');
  assert.ok((await page.locator('#search-status').innerText()).trim());
  assert.equal(await page.locator('#chapter-nav').isVisible(), false);
  await page.screenshot({ path: `work/reading-search-${label}.png`, animations: 'disabled' });
  const resultHref = await first.getAttribute('href');
  const resultParams = new URLSearchParams(resultHref.split('?')[1]);
  assert.ok(resultParams.get('section') && resultParams.get('match'), 'Search must point to both its section and matched passage');
  await first.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(({ id, hash }) => location.hash === hash && document.getElementById(id)?.classList.contains('search-destination'), { id: resultParams.get('match'), hash: resultHref });
  const match = page.locator(`[id="${resultParams.get('match')}"]`);
  assert.ok((await match.innerText()).toLowerCase().includes('call_id'));
  assert.ok(await match.evaluate(node => node.getBoundingClientRect().top >= 50 && node.getBoundingClientRect().top < innerHeight));
  assert.ok(await match.evaluate(node => node.classList.contains('search-destination')), 'The selected passage should remain easy to find');

  for (const query of ['no-such-course-term-9f6a21', 'flowchart LR']) {
    await page.locator('#chapter-search').fill(query);
    await page.waitForFunction(query => document.querySelectorAll('#search-results a.search-result').length === 0 && /没有|未找到|无匹配/.test(document.querySelector('#search-status')?.textContent || '') && document.querySelector('#search-status').textContent.includes(query), query);
  }
  await page.locator('#clear-search').click();
  assert.equal(await page.locator('#chapter-search').inputValue(), '');
  await page.locator('#chapter-nav').waitFor();

  // Search a real paragraph that begins inside a closed disclosure.
  await page.goto(url + route('02-tools')); await settled(page, '02-tools');
  const folded = await page.locator('#chapter-02-tools .prose details p[id]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, text: node.textContent.replace(/\s+/g, ' ').trim() })).find(item => item.text.length > 30));
  assert.ok(folded, 'The folded-search regression needs a real indexed paragraph');
  await page.locator('#chapter-02-tools .prose details').evaluateAll(nodes => nodes.forEach(node => node.open = false));
  assert.equal(await page.locator(`[id="${folded.id}"]`).isVisible(), false, 'The search fixture must start folded');
  await page.locator('#chapter-search').fill(folded.text.slice(0, 26));
  const foldedResult = page.locator('#search-results a.search-result').filter({ has: page.locator('.chapter-title', { hasText: catalog.lessons.find(item => item.id === '02-tools').title }) }).first();
  await foldedResult.waitFor(); await foldedResult.click();
  await page.waitForFunction(id => document.getElementById(id)?.classList.contains('search-destination'), folded.id);
  assert.ok(await page.locator(`[id="${folded.id}"]`).evaluate(node => { for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.open) return false; return Boolean(node.getClientRects().length); }), 'Search must open the disclosure around its hit');
  await page.locator('#clear-search').click();

  await page.goto(url + route('01-request')); await settled(page, '01-request');
  const term = page.locator('#chapter-01-request .term-trigger').first();
  await term.focus(); await page.keyboard.press('Enter');
  await page.locator('#term-definition:popover-open').waitFor();
  const termName = await term.innerText();
  assert.ok((await page.locator('#term-definition').innerText()).includes(termName));
  assert.ok((await page.locator('#term-definition').innerText()).length > termName.length + 15, 'A term needs its actual glossary definition');
  assert.ok(await page.locator('[data-close-term]').evaluate(node => node === document.activeElement), 'Opening a term must place focus in its explanation');
  await page.keyboard.press('Tab');
  assert.ok(await page.locator('#term-definition a').evaluate(node => node === document.activeElement), 'The primary chapter link must be the next keyboard action');
  await page.screenshot({ path: `work/reading-term-${label}.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#term-definition:popover-open').count(), 0);
  assert.ok(await term.evaluate(node => node === document.activeElement), 'Closing the explanation must return focus to the term');
  await term.press('Enter'); await page.locator('[data-close-term]').press('Enter');
  assert.ok(await term.evaluate(node => node === document.activeElement), 'The close button must also return focus to the original term');

  await page.locator('#focus-toggle').click();
  assert.equal(await page.locator('#focus-toggle').getAttribute('aria-pressed'), 'true');
  assert.ok(await page.locator('body').evaluate(node => node.classList.contains('focus-reading')));
  assert.ok(await page.locator('.course-sidebar').evaluate(node => node.inert), 'A hidden focus-mode directory must not receive focus');
  await noOverflow('Desktop focus reading');
  await page.screenshot({ path: `work/reading-focus-${label}.png`, animations: 'disabled' });
  await page.locator('#focus-toggle').click();

  // Save through actual reading, survive a reload, and require the explicit
  // continue entry. No checklist or learning-state key may be changed.
  const unrelatedStorage = () => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key !== 'ah-reading-position'));
  const storageBefore = await page.evaluate(unrelatedStorage);
  const readingSection = Object.values(sectionIds['01-request'])[1];
  await page.goto(url + route('01-request', { section: readingSection })); await settled(page, '01-request');
  const previousPosition = await page.evaluate(() => localStorage.getItem('ah-reading-position'));
  await page.evaluate(() => scrollBy(0, 110));
  await page.waitForFunction(previous => { try { const value = localStorage.getItem('ah-reading-position'); const saved = JSON.parse(value); return value !== previous && saved?.lesson === '01-request' && saved.section && Number.isFinite(saved.offset); } catch { return false; } }, previousPosition);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ah-reading-position')));
  const savedY = await page.evaluate(() => scrollY);
  await page.goto(url + '#/'); await page.reload();
  await page.locator('#continue-reading a').waitFor();
  assert.ok((await page.locator('#continue-reading').innerText()).includes('不代表已经掌握'));
  assert.ok((await page.locator('#continue-reading a').innerText()).includes(saved.label));
  await page.locator('#continue-reading a').click(); await settled(page, '01-request');
  await page.waitForFunction(y => Math.abs(scrollY - y) <= 4, savedY);
  assert.deepEqual(await page.evaluate(unrelatedStorage), storageBefore, 'Reading must not update mastery or other user state');
  await page.goto(url + route('05-context')); await settled(page, '05-context');
  const diagram = page.locator('#chapter-05-context .mermaid').first();
  await diagram.locator('svg').waitFor();
  const diagramId = await diagram.getAttribute('id');
  assert.ok(diagramId?.startsWith('05-context-passage-'), 'A diagram must keep its stable prose anchor');
  await diagram.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await page.waitForFunction(id => { try { return JSON.parse(localStorage.getItem('ah-reading-position'))?.section === id; } catch { return false; } }, diagramId);
  const diagramTop = (await diagram.boundingBox()).y;
  await page.goto(url + '#/'); await page.reload(); await page.locator('#continue-reading a').click(); await settled(page, '05-context');
  await page.waitForFunction(({ id, top }) => Math.abs(document.getElementById(id).getBoundingClientRect().top - top) <= 4, { id: diagramId, top: diagramTop });
  await page.goto(url + route('01-request')); await settled(page, '01-request');
  await page.waitForFunction(() => scrollY === 0);

  const targets = page.locator('#chapter-01-request .reading-targets a');
  assert.ok(await targets.count() >= 2, 'Chapter one needs separate context and user-message observation targets');
  const target5 = page.locator('#chapter-01-request .reading-targets a[href*="input=5"]').first();
  const target6 = page.locator('#chapter-01-request .reading-targets a[href*="input=6"]').first();
  assert.ok(await target5.count() && await target6.count());
  const evidenceLink = page.locator('#chapter-01-request .prose a[href*="experiment=01-hello"]').first();
  await evidenceLink.scrollIntoViewIfNeeded();
  const beforeEvidence = await page.evaluate(() => scrollY);
  await evidenceLink.click();
  await page.locator('[data-workbench="01-request"] [data-return-reading]').waitFor();
  await page.locator('[data-workbench="01-request"] [data-return-reading]').click(); await settled(page, '01-request');
  await page.waitForFunction(y => Math.abs(scrollY - y) <= 4, beforeEvidence);
  await target5.click();
  await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('input') === '5' && document.querySelector('[data-workbench="01-request"] [data-item-path="input[5]"]')?.open);
  assert.ok(await page.locator('[data-workbench="01-request"] [data-item-path="input[5]"]').evaluate(node => node.open));
  assert.equal(await page.locator('[data-workbench="01-request"] .request-metadata details').evaluate(node => node.open), false, 'Secondary request metadata should start folded');
  await target6.click();
  await page.waitForFunction(() => document.querySelector('[data-workbench="01-request"] [data-item-path="input[6]"]')?.open);
  assert.ok((await page.locator('[data-item-path="input[6]"]').innerText()).includes('你好'));
  await page.screenshot({ path: `work/reading-workbench-${label}.png`, animations: 'disabled' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url + route('01-request')); await settled(page, '01-request');
  const menu = page.locator('.menu-toggle');
  const sidebar = page.locator('.course-sidebar');
  assert.ok(await sidebar.evaluate(node => node.inert));
  await menu.focus();
  for (let step = 0; step < 20; step++) {
    await page.keyboard.press('Tab');
    assert.equal(await sidebar.evaluate(node => node.contains(document.activeElement)), false, 'Closed mobile directory received keyboard focus');
  }
  await menu.click();
  assert.equal(await menu.getAttribute('aria-expanded'), 'true');
  assert.equal(await sidebar.getAttribute('aria-modal'), 'true');
  assert.ok(await sidebar.evaluate(node => node.contains(document.activeElement)), 'Opening the directory must move focus inside');
  await page.locator('.sidebar-close').focus(); await page.keyboard.press('Shift+Tab');
  assert.ok(await sidebar.evaluate(node => node.contains(document.activeElement)), 'Backward Tab must stay inside the mobile menu');
  await page.keyboard.press('Tab');
  assert.ok(await sidebar.evaluate(node => node.contains(document.activeElement)), 'Forward Tab must stay inside the mobile menu');
  await page.screenshot({ path: `work/reading-menu-mobile-${label}.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  assert.equal(await menu.getAttribute('aria-expanded'), 'false');
  assert.ok(await menu.evaluate(node => node === document.activeElement));
  assert.ok(await sidebar.evaluate(node => node.inert));
  await menu.click(); await page.locator('.course-sidebar a[href="#/lesson/02-tools"]').click(); await settled(page, '02-tools');
  assert.equal(await menu.getAttribute('aria-expanded'), 'false');
  assert.equal(await sidebar.evaluate(node => node.contains(document.activeElement)), false, 'Navigation must not leave focus in the closed menu');
  await noOverflow('Mobile article');
  assert.ok(await page.locator('#chapter-02-tools .prose').evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16), 'Mobile prose is too small');
  await page.screenshot({ path: `work/reading-mobile-light-${label}.png`, animations: 'disabled' });
  await page.locator('#theme-toggle').click(); await noOverflow('Mobile dark article');
  await page.screenshot({ path: `work/reading-mobile-dark-${label}.png`, animations: 'disabled' });
  await page.locator('#theme-toggle').click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await sidebar.evaluate(node => node.inert), false, 'Desktop navigation must become available after resizing');
  console.log(`Reading checks passed (${label}): ${anchors.length} historical anchors with exact destination text; ${guidedTargets} guided evidence targets including raw kinds; paragraph search, folded hit, empty/clear and keyboard selection; inline terms; explicit reading restore without mastery changes; evidence targets/return; focus mode; mobile inert/focus trap/Escape/navigation; light/dark screenshots.`);
}

// Reuse the same reader checks against the actual Pages deployment.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2];
  assert.ok(url?.startsWith('http'), 'Usage: node scripts/check-reading.mjs https://host/how-codex-works/');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  page.on('requestfailed', request => errors.push(`${request.failure()?.errorText}: ${request.url()}`));
  try {
    const check = process.argv.includes('--workbench-only') ? checkWorkbenchDefaults : process.argv.includes('--diagram-only') ? checkDiagramReentry : process.argv.includes('--layout-only') ? checkReaderLayout : checkReading;
    await check(page, url.endsWith('/') ? url : url + '/', 'live');
    assert.deepEqual(errors, [], 'Published reader has console or resource failures');
  } catch (error) {
    await mkdir('work', { recursive: true });
    await page.screenshot({ path: 'work/reading-live-failure.png', animations: 'disabled' });
    throw error;
  } finally { await browser.close(); }
}
