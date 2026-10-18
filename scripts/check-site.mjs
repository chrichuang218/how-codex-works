import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, extname } from 'node:path';
import { chromium } from '@playwright/test';
import { marked } from 'marked';
import { checkReading } from './check-reading.mjs';

const root = resolve('dist');
const catalog = JSON.parse(await readFile('course/catalog.json', 'utf8'));
const { experiments } = JSON.parse(await readFile('evidence/desktop-lab/index.json', 'utf8'));
const screenshotIndex = JSON.parse(await readFile('docs/images/desktop-lab/index.json', 'utf8'));
const permissionPictures = screenshotIndex.images.filter(image => image.chapters.includes('10-permissions') && image.experiments.some(experiment => experiment.id === '15-permissions'));
assert.ok(permissionPictures.length, 'The permissions chapter needs its own screenshot of the sandbox experiment.');
const sourceBase = 'https://github.com/chrichuang218/how-codex-works/blob/main/';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const captureReadme = process.argv.includes('--capture-readme');
const basePath = '/how-codex-works/';
const stages = experiments.flatMap(experiment => experiment.stages.map((stage, index) => ({ experiment, stage, index })));
assert.equal(catalog.lessons.length, 16);
assert.equal(catalog.groups.length, 4);
assert.ok(experiments.length > 0, 'The evidence index must contain experiments.');
assert.ok(stages.length > 0, 'Every indexed stage must be verified.');
assert.equal(new Set(experiments.map(experiment => experiment.id)).size, experiments.length, 'Experiment IDs must be unique.');
const expectedPreviousCount = (await Promise.all(stages.map(({ stage }) => readFile(stage.requestFile, 'utf8').then(JSON.parse)))).filter(request => request.previous_response_id).length;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    // Serve the deployed Pages path without a root fallback. Absolute /assets
    // or /licenses URLs must fail here instead of passing only on localhost.
    if (!pathname.startsWith(basePath)) { response.writeHead(404).end(); return; }
    const localPath = pathname.slice(basePath.length) || 'index.html';
    const file = resolve(root, localPath);
    if (!file.startsWith(root + '/') && !file.startsWith(root + '\\')) { response.writeHead(403).end(); return; }
    response.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'], reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  const badResources = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.url().startsWith('http://127.0.0.1:') && response.status() >= 400) badResources.push(`${response.status()} ${response.url()}`); });
  page.on('requestfailed', request => badResources.push(`${request.failure()?.errorText}: ${request.url()}`));
  const url = `http://127.0.0.1:${server.address().port}${basePath}`;
  const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
  const owner = experiment => catalog.lessons.find(lesson => lesson.evidenceIds.includes(experiment.id));
  const noOverflow = async label => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, label + ': horizontal page overflow');
  async function waitChapter(id) {
    await page.waitForFunction(id => {
      const visible = [...document.querySelectorAll('.chapter')].filter(chapter => chapter.getClientRects().length);
      return document.querySelector('#main')?.getAttribute('aria-busy') === 'false' && visible.length === 1 && visible[0].dataset.lesson === id;
    }, id);
    assert.equal(await page.locator('.home-page:visible,.introduction:visible').count(), 0, id + ': another reading surface is visible');
    assert.equal(await page.locator('.chapter:visible').count(), 1, id + ': only the current chapter may be visible');
  }
  async function waitWorkbench(id, experimentId, index, viewName) {
    await waitChapter(id);
    await page.waitForFunction(({ id, experimentId, index, viewName }) => {
      const host = document.querySelector(`[data-workbench="${id}"]`);
      return host?.getClientRects().length && host.dataset.experiment === experimentId && host.dataset.stage === String(index) && host.dataset.view === viewName && host.getAttribute('aria-busy') === 'false' && host.dataset.ready === 'true';
    }, { id, experimentId, index, viewName });
    return page.locator(`[data-workbench="${id}"]`);
  }
  async function openWorkbench(experiment, stage, view, extra = {}) {
    const lesson = owner(experiment);
    assert.ok(lesson, 'Experiment is not reachable: ' + experiment.id);
    const query = new URLSearchParams({ experiment: experiment.id, stage: String(stage), view, ...extra });
    await page.goto(url + '#/lesson/' + lesson.id + '?' + query);
    return waitWorkbench(lesson.id, experiment.id, stage, view);
  }
  async function verifyItems(host, expected, prefix, label) {
    const rendered = await host.locator('.workbench-content').evaluate((container, prefix) => [...container.querySelectorAll(`.trace-item[data-item-path^="${prefix}["]`)].map(item => ({
      path: item.dataset.itemPath,
      role: item.querySelector(':scope > summary .role-badge').textContent,
      original: JSON.parse(item.querySelector(':scope > .trace-item-body > .raw-details > .code-panel > pre').textContent),
      blocks: [...item.querySelectorAll('[data-full-content]')].map(block => ({ path: block.dataset.fullContent, text: block.textContent })),
    })), prefix);
    assert.equal(rendered.length, expected.length, label + ': omitted/reordered items');
    for (let index = 0; index < expected.length; index++) {
      const actual = rendered[index]; const source = expected[index];
      assert.equal(actual.path, `${prefix}[${index}]`, label + ': item position');
      assert.equal(actual.role, source.role || '无 role 字段', label + ': role');
      assert.ok(JSON.stringify(actual.original) === JSON.stringify(source), `${label}: complete ${prefix}[${index}] fields changed`);
      if (Array.isArray(source.content)) {
        assert.equal(actual.blocks.length, source.content.length, `${label}: content block omitted`);
        source.content.forEach((block, blockIndex) => {
          const value = actual.blocks[blockIndex];
          assert.equal(value.path, `${prefix}[${index}].content[${blockIndex}]`);
          assert.ok(value.text === (typeof block.text === 'string' ? block.text : JSON.stringify(block, null, 2)), `${label}: ${prefix}[${index}].content[${blockIndex}] truncated or changed`);
        });
      }
    }
  }
  await page.goto(url);
  await page.locator('#main[aria-busy="false"]').waitFor();
  assert.equal(await page.locator('#main > .error-state').count(), 0, await page.locator('#main').innerText());
  assert.equal(await page.locator('.home-page h1').textContent(), 'Codex 是如何工作的');
  assert.ok((await page.locator('.home-page h1').boundingBox()).y >= (await page.locator('.site-header').boundingBox()).height, 'Fixed header must not cover the opening title.');
  assert.equal(await page.locator('.chapter:visible,.introduction:visible').count(), 0, 'The home page must not show the full course below its cards.');
  assert.equal(await page.locator('.learning-path .phase-section').count(), 4);
  assert.equal(await page.locator('.learning-path .lesson-card').count(), 16);
  for (const [index, group] of catalog.groups.entries()) {
    const phase = page.locator('.learning-path .phase-section').nth(index);
    assert.ok((await phase.innerText()).includes(group.title));
    const expected = catalog.lessons.filter(lesson => lesson.group === group.id).map(lesson => '#/lesson/' + lesson.id);
    const actual = await phase.locator('a.lesson-card').evaluateAll(cards => cards.map(card => card.getAttribute('href')));
    assert.deepEqual(actual, expected, group.id + ': cards must preserve the Chinese course order.');
  }
  assert.equal(await page.locator('dialog').count(), 0, 'Reading/evidence must not require a dialog.');
  assert.ok((await page.locator('.home-hero').innerText()).includes('Hello World'));
  assert.ok((await page.locator('.home-hero p').allTextContents()).join('\n').includes('请求中可见的完整上下文'));
  await page.locator('[data-hello-request]').click();
  let helloEntry = await waitWorkbench('01-request', '01-hello', 1, 'request');
  assert.ok((await helloEntry.locator('[data-item-path="input[6]"]').innerText()).includes('你好'), 'Hello World entry must open the real greeting request, not the prewarm.');
  await page.goBack(); await page.locator('.home-page:visible').waitFor();
  await page.locator('[data-hello-response]').click();
  helloEntry = await waitWorkbench('01-request', '01-hello', 1, 'output');
  assert.ok((await helloEntry.innerText()).includes(experiments.find(item => item.id === '01-hello').reply), 'Response entry must show the recorded greeting output.');
  await page.goBack(); await page.locator('.home-page:visible').waitFor();
  for (const [name, copyright] of [['learn-claude-code', '2024 shareAI Lab'], ['how-claude-code-works', '2025 Windy3f3f3f3f']]) {
    const licenseUrl = url + `licenses/${name}.txt`;
    const licenseResponse = await context.request.get(licenseUrl);
    assert.equal(licenseResponse.status(), 200);
    const licenseText = await licenseResponse.text();
    assert.ok(licenseText.includes('MIT License') && licenseText.includes('Copyright (c) ' + copyright));
  }
  await noOverflow('Desktop homepage');
  await mkdir('work', { recursive: true });
  await page.screenshot({ path: 'work/site-reader-desktop.png', fullPage: false, animations: 'disabled' });
  if (captureReadme) { await mkdir('docs/images', { recursive: true }); await page.screenshot({ path: 'docs/images/site-preview.png', fullPage: false, animations: 'disabled' }); }

  await page.locator('.home-example a').click();
  await waitChapter('03-agent-loop');
  assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('section'), 'agent-loop-timeline');
  assert.ok(await page.locator('.chapter-outline [data-section="agent-loop-timeline"]').count(), 'The real repair timeline should have a chapter-outline entry.');
  const timelineTop = (await page.locator('#agent-loop-timeline').boundingBox()).y;
  assert.ok(timelineTop >= 60 && timelineTop < 200, 'The homepage repair link must land on the real request timeline.');
  await page.screenshot({ path: 'work/site-timeline-desktop.png', fullPage: false, animations: 'disabled' });
  await page.goBack();
  await page.locator('.home-page:visible').waitFor();

  await page.locator('[data-start-learning]').click();
  await waitChapter('01-request');
  assert.ok((await page.locator('.breadcrumb').innerText()).includes('一次请求'));
  await page.screenshot({ path: 'work/site-chapter-desktop.png', fullPage: false, animations: 'disabled' });
  await page.goBack();
  await page.locator('.home-page:visible').waitFor();
  assert.equal(await page.locator('.chapter:visible').count(), 0);
  await page.locator('a[href="#/guide"]:visible').first().click();
  await page.locator('.introduction:visible h1').waitFor();
  assert.equal(await page.locator('.introduction h1').innerText(), 'Codex 是如何工作的');
  assert.equal(await page.locator('.chapter:visible,.home-page:visible').count(), 0);
  assert.ok(await page.locator('.introduction').evaluate(element => parseFloat(getComputedStyle(element).fontSize)) >= 15, 'Long-form guide text must remain readable.');
  await noOverflow('Desktop guide');
  assert.equal(await page.locator('.chapter-outline').evaluate(element => element.parentElement.dataset.navLesson), 'introduction');

  // A chapter's disclosure state belongs to the reader, not the route/scroll renderer.
  const navigationChecks = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(url + '#/lesson/03-agent-loop'); await page.reload(); await waitChapter('03-agent-loop');
    await page.waitForLoadState('networkidle');
    const mobile = width === 390;
    const openMenu = async () => {
      if (mobile && await page.locator('.menu-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('.menu-toggle').click();
    };
    await openMenu();
    const toggle = page.locator('[data-toggle-outline="03-agent-loop"]');
    const outline = page.locator('#outline-03-agent-loop');
    const nextLink = page.locator('[data-nav-lesson="02-tools"] .chapter-link');
    const currentLink = page.locator('[data-nav-lesson="03-agent-loop"] .chapter-link');
    assert.equal(await page.locator('.nav-group > h2 > .nav-phase-label').count(), 4, 'Every group needs a distinct phase label.');
    assert.equal(await page.locator('.nav-group > h2 > .nav-group-title').count(), 4, 'Every phase needs its own heading.');
    assert.equal(await toggle.getAttribute('aria-controls'), 'outline-03-agent-loop');
    assert.equal(await page.locator('.chapter-toggle:not([hidden])').count(), 1, 'Only the current chapter exposes a disclosure button.');
    assert.ok(await outline.locator('a').evaluateAll(links => links.every(link => Number.isInteger(Number(link.dataset.depth)) && Number(link.dataset.depth) >= 0 && link.style.getPropertyValue('--section-depth') !== '')), 'Section depth must be explicit for every outline entry.');
    const sectionHref = await outline.locator('a[data-section]').nth(1).getAttribute('href');
    const checkDisclosure = async expanded => {
      assert.equal(await toggle.getAttribute('aria-expanded'), String(expanded), `${width}px: disclosure accessibility state`);
      assert.equal(await outline.evaluate(element => element.hidden), !expanded, `${width}px: actual disclosure state`);
      assert.equal(await page.locator('.chapter-outline').count(), 1, 'Collapsing must preserve a single current outline.');
    };
    await checkDisclosure(true);
    await page.evaluate(() => window.scrollTo(0, 850));
    await page.waitForFunction(() => scrollY === 850);
    const before = { url: page.url(), scrollY: await page.evaluate(() => scrollY) };
    await toggle.click(); await checkDisclosure(false);
    assert.equal(page.url(), before.url, 'The disclosure button must not navigate.');
    assert.equal(await page.evaluate(() => scrollY), before.scrollY, 'Collapsing must not move the article.');
    assert.ok(await toggle.evaluate(element => document.activeElement === element), 'Collapsing must preserve button focus.');
    if (mobile) assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'), 'true', 'A disclosure button must not close the mobile menu.');
    await page.evaluate(() => window.scrollTo(0, 1100));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await checkDisclosure(false);
    assert.equal(await page.evaluate(() => scrollY), 1100, 'Scroll tracking must not bounce back after collapse.');
    await page.screenshot({ path: `work/site-navigation-${width}-collapsed.png`, animations: 'disabled' });
    await toggle.press('Space'); await checkDisclosure(true);
    await toggle.press('Enter'); await checkDisclosure(false);
    await toggle.click(); await checkDisclosure(true);
    assert.equal(page.url(), before.url);
    assert.equal(await page.evaluate(() => scrollY), 1100, 'Mouse and keyboard disclosure must preserve article scroll.');
    assert.ok(await toggle.evaluate(element => document.activeElement === element), 'Re-expanding must preserve button focus.');
    if (mobile) assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'), 'true');
    await page.screenshot({ path: `work/site-navigation-${width}-expanded.png`, animations: 'disabled' });
    await toggle.click(); await checkDisclosure(false);
    await page.evaluate(hash => { location.hash = hash; }, sectionHref);
    await page.waitForFunction(hash => location.hash === hash && document.querySelector('#main').getAttribute('aria-busy') === 'false', sectionHref);
    await checkDisclosure(false);
    await openMenu();
    await currentLink.click(); await waitChapter('03-agent-loop'); await checkDisclosure(false);
    if (mobile) assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'), 'false', 'A chapter link must close the mobile menu.');
    await openMenu();
    await page.locator('#chapter-search').fill('call_id');
    await page.locator('#search-results a.search-result').first().waitFor();
    assert.equal(await page.locator('#chapter-nav').isVisible(), false);
    await page.locator('#chapter-search').fill('');
    await page.locator('#chapter-nav').waitFor();
    await checkDisclosure(false);
    await nextLink.click(); await waitChapter('02-tools');
    assert.equal(await page.locator('[data-nav-lesson="02-tools"] .chapter-link').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('[data-toggle-outline="02-tools"]').getAttribute('aria-expanded'), 'true', 'A newly visited chapter opens its outline.');
    assert.equal(await page.locator('[data-nav-lesson="03-agent-loop"] .chapter-outline').count(), 0, 'Inactive chapters must not retain section DOM.');
    if (mobile) assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'), 'false');
    await openMenu(); await currentLink.click(); await waitChapter('03-agent-loop'); await checkDisclosure(false);
    assert.equal(await currentLink.getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.chapter-link[aria-current="page"]').count(), 1, 'Only the current chapter is highlighted.');
    await page.reload(); await waitChapter('03-agent-loop'); await openMenu(); await checkDisclosure(true);
    await outline.locator('a[data-section]').nth(1).click(); await waitChapter('03-agent-loop');
    assert.equal(new URL(page.url()).hash, sectionHref, 'Expanded section links must still navigate.');
    if (mobile) assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'), 'false', 'A section link must close the mobile menu.');
    await noOverflow(`${width}px chapter disclosure`);
    navigationChecks.push({ width, mouseAndKeyboard: true, scrollAndFocusPreserved: true, sameChapterRoutes: true, chapterState: true, search: true, reloadResets: true, mobileMenu: mobile ? 'verified' : 'not-applicable' });
  }
  await writeFile('work/site-navigation-checks.json', JSON.stringify(navigationChecks, null, 2) + '\n');
  console.log('Verified reversible chapter disclosure at 1440px and 390px, mouse/keyboard, focus/scroll, same-chapter routes, chapter history, search and mobile menu.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  // The full evidence traversal below starts with fresh per-document disclosure state.
  await page.reload(); await waitChapter('03-agent-loop');

  await page.goto(url + '#/lesson/01-request');
  await waitChapter('01-request');
  const screenshot = page.locator('#chapter-01-request .prose img').first();
  const lightCode = page.locator('.code-panel').first();
  assert.ok(await lightCode.evaluate(element => Math.min(...getComputedStyle(element).backgroundColor.match(/\d+/g).slice(0, 3).map(Number)) > 230), 'Light-mode code should use a light background.');
  assert.ok(await lightCode.evaluate(element => Math.max(...getComputedStyle(element).color.match(/\d+/g).slice(0, 3).map(Number)) < 100), 'Light-mode code must use dark text.');
  assert.ok(await screenshot.count(), 'Real Desktop screenshot is missing.');
  const asset = await screenshot.getAttribute('src');
  assert.equal((await context.request.get(new URL(asset, url).href)).status(), 200, 'Vite image asset is missing.');
  assert.equal(await screenshot.locator('..').getAttribute('target'), '_blank');
  assert.equal(await screenshot.locator('..').getAttribute('href'), new URL(asset, url).href);
  assert.ok((await screenshot.locator('..').innerText()).includes('查看原图'));
  const imagePagePromise = context.waitForEvent('page');
  await screenshot.locator('..').click();
  const imagePage = await imagePagePromise;
  await imagePage.waitForLoadState();
  assert.equal(imagePage.url(), new URL(asset, url).href, 'Opening the original image should preserve its actual asset URL.');
  await imagePage.screenshot({ path: 'work/site-screenshot-original.png', fullPage: false });
  await imagePage.close();

  // Navigation is a real route change, not a scroll through hidden chapters.
  await page.locator('.reader-page:visible .chapter-pagination a[data-direction="next"]').click();
  await waitChapter('02-tools');
  await page.locator('.reader-page:visible .chapter-pagination a[data-direction="previous"]').click();
  await waitChapter('01-request');
  await page.goBack();
  await waitChapter('02-tools');

  await page.goto(url + '#/lesson/02-tools');
  await page.reload();
  await waitChapter('02-tools');
  await page.waitForLoadState('networkidle');
  const toolsTop = (await page.locator('#chapter-02-tools').boundingBox()).y;
  assert.ok(toolsTop >= 60 && toolsTop < 200, 'A direct chapter link must stay at the chapter after neighbouring evidence loads.');

  const legacyRoutes = {
    '01-hello': '01-request', '02-context': '04-session', '03-readme': '02-tools',
    '04-agents': '06-agents', '05-skills': '07-skills', '06-tests': '03-agent-loop',
    '07-fix': '03-agent-loop', '08-session': '04-session', '09-context': '05-context',
    '10-compaction': '05-context', '11-cache': '05-context', '12-memory': '08-memory',
    '13-mcp': '09-mcp', '14-plan': '11-plan', '15-permissions': '10-permissions',
    '16-multi-agent': '12-multi-agent', '17-goal': '13-autonomy', '18-streaming': '14-streaming',
    '19-recovery': '13-autonomy', '20-interruption': '13-autonomy',
  };
  assert.deepEqual(catalog.legacyRoutes, legacyRoutes, 'Previous chapter destinations must match the topic reorganization.');
  for (const [previous, current] of Object.entries(legacyRoutes)) {
    await page.goto(url + '#/lesson/' + previous + '?section=' + previous + '-section-0');
    await page.waitForFunction(id => location.hash === '#/lesson/' + id, current);
    await waitChapter(current);
    assert.ok((await page.title()).startsWith(catalog.lessons.find(lesson => lesson.id === current).title));
    assert.ok((await page.locator('#chapter-' + current).boundingBox()).y < 200, previous + ': old heading must land at its new chapter');
  }
  for (const previous of ['#/lesson/introduction', '#/lesson/0', '#/intro', '#/introduction']) {
    await page.goto(url + previous);
    await page.waitForFunction(() => location.hash === '#/guide');
    await page.locator('.introduction:visible').waitFor();
    assert.equal(await page.locator('.chapter:visible,.home-page:visible').count(), 0);
  }
  const hookIds = ['hook-marker-repeat', 'hook-pre-tool', 'hook-post-tool', 'hook-c-trusted-ui', 'hook-a-baseline', 'hook-b-untrusted', 'hook-c-tool-origin'];
  const hooks = catalog.lessons.find(lesson => lesson.id === '10-hooks');
  assert.deepEqual(hooks.evidenceIds, hookIds, 'The independent Hooks chapter must own all seven Hook experiments.');
  assert.equal(catalog.lessons[catalog.lessons.indexOf(hooks) - 1].id, '09-mcp');
  assert.equal(catalog.lessons[catalog.lessons.indexOf(hooks) + 1].id, '10-permissions');
  for (const lesson of catalog.lessons.filter(lesson => lesson !== hooks)) assert.ok(!lesson.evidenceIds.some(id => hookIds.includes(id)), lesson.id + ': stale Hook ownership');
  await page.goto(url + '#/'); await page.locator('.home-page:visible').waitFor();
  await page.locator('.lesson-card[data-card-lesson="10-hooks"]').click(); await waitChapter('10-hooks');
  assert.equal(await page.locator('[data-nav-lesson="10-hooks"] .nav-number').textContent(), '10');
  assert.equal(await page.locator('#chapter-10-hooks .prose img').count(), 3, 'The Hooks chapter must contain the three real event screenshots.');
  assert.ok(await page.locator('#chapter-10-hooks .prose img').evaluateAll(images => images.every(image => !image.closest('details'))), 'All three Hook event screenshots must appear in the main article.');
  await page.screenshot({ path: 'work/site-hooks-desktop.png', fullPage: false, animations: 'disabled' });
  for (const experimentId of hookIds) {
    const experiment = experiments.find(item => item.id === experimentId);
    const previousOwners = experimentId === 'hook-pre-tool' ? ['10-permissions', '15-permissions'] : experimentId === 'hook-post-tool' ? ['15-architecture'] : ['06-agents', '04-agents'];
    const request = await readJson(experiment.stages[0].requestFile);
    const inputIndex = request.input.findIndex(item => Array.isArray(item.content) && item.content.length);
    assert.ok(inputIndex >= 0, experimentId + ': a real content block is required for the legacy jump check.');
    for (const previous of previousOwners) {
      const params = new URLSearchParams({ experiment: experimentId, stage: '0', view: 'request', kind: 'eventsFile', input: String(inputIndex), content: '0' });
      await page.goto(url + '#/lesson/' + previous + '?' + params);
      const host = await waitWorkbench('10-hooks', experimentId, 0, 'request');
      assert.equal(new URL(page.url()).hash, '#/lesson/10-hooks?' + params, previous + ': moving ownership must preserve every evidence parameter.');
      const content = host.locator(`[data-full-content="input[${inputIndex}].content[0]"]`);
      assert.ok(await content.isVisible(), previous + ': old content bookmark must reveal its exact block.');
      const block = request.input[inputIndex].content[0];
      assert.equal(await content.textContent(), typeof block.text === 'string' ? block.text : JSON.stringify(block, null, 2));
      params.set('view', 'raw');
      await page.goto(url + '#/lesson/' + previous + '?' + params);
      const rawHost = await waitWorkbench('10-hooks', experimentId, 0, 'raw');
      assert.equal(new URL(page.url()).hash, '#/lesson/10-hooks?' + params);
      assert.equal(await rawHost.locator('.raw-select').inputValue(), 'eventsFile');
      assert.equal(await rawHost.locator('[data-raw-content]').textContent(), await readFile(experiment.stages[0].eventsFile, 'utf8'));
      await page.goto(url + '#/lesson/' + previous + '?file=' + encodeURIComponent(experiment.auditFile));
      const supplement = page.locator('#supplement-10-hooks [data-supplement-content]');
      await page.waitForFunction(path => {
        const host = document.querySelector('#supplement-10-hooks');
        return host?.dataset.sourcePath === path && host.getAttribute('aria-busy') === 'false' && host.getClientRects().length;
      }, experiment.auditFile);
      assert.equal(new URL(page.url()).hash, '#/lesson/10-hooks?file=' + encodeURIComponent(experiment.auditFile));
      assert.equal(await supplement.textContent(), await readFile(experiment.auditFile, 'utf8'));
    }
  }
  const expectedHookSections = {
    '06-agents:06-agents-section-7': { lesson: '10-hooks', section: '10-hooks-section-2' },
    '10-permissions:10-permissions-section-7': { lesson: '10-hooks', section: '10-hooks-section-3' },
    '15-architecture:15-architecture-section-5': { lesson: '10-hooks', section: '10-hooks-section-4' },
  };
  for (const [source, target] of Object.entries(expectedHookSections)) assert.deepEqual(catalog.sectionRedirects[source], target, source + ': existing Hooks destination changed.');
  for (const [previous, target] of Object.entries(expectedHookSections)) {
    const [lesson, section] = previous.split(':');
    await page.goto(url + '#/lesson/' + lesson + '?section=' + section);
    await waitChapter('10-hooks');
    assert.equal(new URL(page.url()).hash, '#/lesson/10-hooks?section=' + target.section);
    assert.ok(await page.locator(`[id="${target.section}"]`).isVisible(), 'Relocated Hook section must exist.');
    await page.reload(); await waitChapter('10-hooks');
    assert.ok((await page.locator(`[id="${target.section}"]`).boundingBox()).y < 200, 'Relocated section must survive refresh.');
  }
  console.log('Verified independent Hooks entry, three screenshots, seven experiment owners and old owner/alias/file/content/section bookmarks.');
  // The context chapter once linked to experiments now taught elsewhere.
  // Existing bookmarks must retain their source, stage and view after moving.
  await page.goto(url + '#/lesson/09-context?experiment=03-readme&stage=1&view=raw&kind=responseFile');
  await waitWorkbench('02-tools', '03-readme', 1, 'raw');
  assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('experiment'), '03-readme');
  assert.equal(await page.locator('[data-workbench="02-tools"] .stage-select').inputValue(), '1');
  assert.equal(await page.locator('[data-workbench="02-tools"] .raw-select').inputValue(), 'responseFile');
  assert.ok(await page.locator('[data-workbench="02-tools"] [data-raw-content]').textContent() === await readFile(experiments.find(item => item.id === '03-readme').stages[1].responseFile, 'utf8'));

  const foldedHeadings = [];
  const runtimeCodePaths = new Set();
  for (const lesson of catalog.lessons) {
    await page.goto(url + '#/lesson/' + lesson.id);
    await waitChapter(lesson.id);
    const chapter = page.locator('#chapter-' + lesson.id);
    const expectedImages = [], exampleLinks = [];
    marked.walkTokens(marked.lexer(await readFile(lesson.file, 'utf8')), token => {
      if (token.type === 'image') expectedImages.push(decodeURIComponent(new URL(token.href, 'https://local.invalid/' + lesson.file).pathname.slice(1)));
      if (token.type === 'link') {
        const path = token.href.startsWith(sourceBase) ? token.href.slice(sourceBase.length) : !/^https?:/.test(token.href) ? decodeURIComponent(new URL(token.href, 'https://local.invalid/' + lesson.file).pathname.slice(1)) : '';
        if (path.startsWith('examples/runtime-lab/')) exampleLinks.push(path);
      }
    });
    assert.equal(await chapter.locator('.prose img').count(), expectedImages.length, lesson.id + ': article screenshot omitted.');
    for (const path of exampleLinks) {
      assert.ok((await readFile(path)).length > 0, path + ': code link must resolve to a local file.');
      const link = chapter.locator(`.prose a[href="${sourceBase + path}"]`);
      assert.ok(await link.count(), path + ': the existing renderer must link directly to the GitHub file.');
      runtimeCodePaths.add(path);
    }
    if (lesson.id === '10-permissions') {
      const experiment = experiments.find(item => item.id === '15-permissions');
      for (const picture of permissionPictures) {
        assert.ok(expectedImages.includes(picture.file), 'The sandbox screenshot must be shown in its permissions chapter.');
        assert.equal(picture.experiments.find(item => item.id === experiment.id).threadId, experiment.threadId, 'Screenshot and log must belong to the same historical task.');
      }
    }
    for (const [imageIndex, image] of (await chapter.locator('.prose img').all()).entries()) {
      const source = new URL(await image.getAttribute('src'), url).href;
      const response = await context.request.get(source);
      assert.equal(response.status(), 200, lesson.id + ': screenshot asset is missing.');
      if (permissionPictures.some(picture => picture.file === expectedImages[imageIndex])) assert.equal(sha(await response.body()), sha(await readFile(expectedImages[imageIndex])), 'The published sandbox screenshot must preserve the local image bytes.');
      assert.equal(await image.locator('..').getAttribute('href'), source, lesson.id + ': original image must keep the actual source URL.');
      assert.equal(await image.locator('..').getAttribute('target'), '_blank', lesson.id + ': original screenshot must open separately.');
      assert.equal(await image.locator('..').locator('a').count(), 0, lesson.id + ': screenshot link must not contain a nested link.');
    }
    foldedHeadings.push(...await chapter.locator('.prose details h2,.prose details h3,.prose details h4,.prose details h5,.prose details h6,.prose details > summary[id]').evaluateAll(headings => headings.filter(heading => heading.tagName !== 'SUMMARY' || heading.textContent.trim().startsWith('深入')).map(heading => ({ id: heading.id, lesson: heading.closest('.chapter').dataset.lesson }))));
    assert.equal(await page.locator('.chapter-outline a').filter({ hasText: /核对答案|参考解释|核对思路/ }).count(), 0, 'Exercise answers should stay out of the chapter outline.');
    assert.deepEqual(await page.locator('.chapter-outline a[data-section]').evaluateAll(links => links.filter(link => document.getElementById(link.dataset.section)?.closest('details')).map(link => link.textContent)), [], 'Folded supplementary content must stay out of the sidebar');
    assert.equal(await page.locator('.page-toc').count(), 0, 'Reading must not duplicate its sidebar outline in a third column.');
    assert.equal(await page.locator('.course-sidebar .chapter-outline').count(), 1, 'Exactly one chapter outline belongs in the sidebar.');
    assert.equal(await page.locator('.chapter-outline').evaluate(element => element.parentElement.dataset.navLesson), lesson.id, 'Only the current chapter can expose section links.');
    assert.ok(await page.locator('.chapter-outline a').count() > 0, 'The current chapter must expose its sections.');
    const expectedPrevious = catalog.lessons.indexOf(lesson) > 0 ? catalog.lessons[catalog.lessons.indexOf(lesson) - 1].id : null;
    const expectedNext = catalog.lessons[catalog.lessons.indexOf(lesson) + 1]?.id;
    if (expectedPrevious) assert.equal(await page.locator('.reader-page:visible .chapter-pagination [data-direction="previous"]').getAttribute('href'), '#/lesson/' + expectedPrevious);
    if (expectedNext) assert.equal(await page.locator('.reader-page:visible .chapter-pagination [data-direction="next"]').getAttribute('href'), '#/lesson/' + expectedNext);
  }
  assert.ok(runtimeCodePaths.size > 0, 'The runnable examples must have direct file entries in the chapters.');
  console.log(`Verified ${runtimeCodePaths.size} runtime-lab code links and ${permissionPictures.length} sandbox screenshots with exact image bytes.`);
  assert.equal(await page.locator('.site-header a[href="#/guide"]').count(), 0, 'The header should not duplicate the guide entry');
  assert.ok(foldedHeadings.length, 'In-depth sections should be reachable through actual folded content headings.');
  for (const { id, lesson } of foldedHeadings) {
    await page.evaluate(() => document.querySelectorAll('.prose details').forEach(details => details.open = false));
    await page.goto(url + '#/lesson/' + lesson + '?section=' + id);
    await waitChapter(lesson);
    await page.waitForFunction(id => {
      const heading = document.getElementById(id);
      for (let node = heading?.parentElement; node; node = node.parentElement) if (node.tagName === 'DETAILS' && !node.open) return false;
      return Boolean(heading?.getClientRects().length);
    }, id);
  }
  const repeatedTarget = foldedHeadings.at(-1);
  await page.evaluate(() => document.querySelectorAll('.prose details').forEach(details => details.open = false));
  await page.reload(); await waitChapter(repeatedTarget.lesson);
  assert.ok(await page.locator(`[id="${repeatedTarget.id}"]`).evaluate(element => element.closest('details').open), 'Refreshing a bookmarked section must reopen its folded content.');
  await page.evaluate(() => document.querySelectorAll('.prose details').forEach(details => details.open = false));
  assert.equal(await page.locator('.nav-chapter:not(.active) .chapter-outline').count(), 0, 'Other chapters must not repeat expanded section links.');

  // Make route requests overlap while a fresh document lazily loads chapters.
  await page.goto(url + '#/');
  await page.reload();
  await page.locator('.home-page:visible').waitFor();
  await page.evaluate(async () => {
    location.hash = '#/lesson/15-architecture';
    await new Promise(resolve => setTimeout(resolve, 0));
    location.hash = '#/lesson/07-skills';
    await new Promise(resolve => setTimeout(resolve, 0));
    location.hash = '#/lesson/02-tools';
  });
  await waitChapter('02-tools');
  await page.waitForLoadState('networkidle');
  await waitChapter('02-tools');
  assert.ok((await page.title()).startsWith(catalog.lessons[1].title), 'A stale lazy load replaced the last route title.');
  assert.ok(await page.locator('.chapter-outline a[data-section]').count() > 0, 'The active chapter outline must exist after overlapping loads.');
  assert.ok(await page.locator('.chapter-outline a[data-section]').evaluateAll(links => links.every(link => link.dataset.section.startsWith('02-tools-') || link.dataset.section === 'workbench-02-tools')), 'A stale lazy load replaced the active outline.');

  // Every recorded stage, including prewarms, is selectable. Compare all input
  // items, roles, content blocks and original objects against public sources.
  let previousCount = 0;
  for (const { experiment, stage, index } of stages) {
    const label = experiment.id + '/' + stage.id;
    let host = await openWorkbench(experiment, index, 'request');
    assert.equal(await host.locator('.stage-select option').count(), experiment.stages.length, label + ': stage selection incomplete');
    const request = await readJson(stage.requestFile);
    await verifyItems(host, request.input || [], 'input', label);
    const top = await host.locator('.workbench-content > .raw-details pre').textContent();
    assert.ok(JSON.stringify(JSON.parse(top)) === JSON.stringify(Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'input'))), label + ': request-level fields changed');
    if (stage.prewarm) assert.ok((await host.locator('.stage-select option:checked').innerText()).includes('预热'));
    if (request.previous_response_id) {
      const previousLink = host.locator('.request-metadata dl > div').nth(2).locator('a');
      const previousHref = await previousLink.getAttribute('href');
      const target = new URLSearchParams(previousHref.split('?')[1]);
      const targetExperiment = experiments.find(item => item.id === target.get('experiment'));
      assert.equal(targetExperiment?.stages[Number(target.get('stage'))]?.responseId, request.previous_response_id, label + ': previous response points to wrong stage');
      await previousLink.evaluate(link => { for (let node = link.parentElement; node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true; });
      await previousLink.click();
      const targetLesson = decodeURIComponent(previousHref.match(/^#\/lesson\/([^?]+)/)[1]);
      const targetHost = await waitWorkbench(targetLesson, targetExperiment.id, Number(target.get('stage')), target.get('view'));
      assert.ok((await targetHost.locator('.request-metadata').textContent()).includes(request.previous_response_id), label + ': following a response reference did not open its recorded stage');
      previousCount++;
    }
    host = await openWorkbench(experiment, index, 'output');
    const derived = stage.outputItemsFile ? await readJson(stage.outputItemsFile) : { items: [] };
    await verifyItems(host, derived.items || [], 'output', label);
    assert.ok((await host.locator('.workbench-content').innerText()).includes('衍生视图'), label + ': derived output must be labelled');
    const completed = await host.locator('.workbench-content > .raw-details pre').textContent();
    assert.ok(JSON.stringify(JSON.parse(completed)) === JSON.stringify(await readJson(stage.responseFile)), label + ': completed event changed');
    host = await openWorkbench(experiment, index, 'compare');
    assert.ok(await host.locator('[data-client-raw]').textContent() === await readFile(stage.requestFile, 'utf8'), label + ': client comparison is incomplete');
    assert.ok(await host.locator('[data-upstream-raw]').textContent() === await readFile(stage.upstreamFile, 'utf8'), label + ': upstream comparison is incomplete');
    host = await openWorkbench(experiment, index, 'raw', { kind: 'eventsFile' });
    assert.ok(await host.locator('[data-raw-content]').textContent() === await readFile(stage.eventsFile, 'utf8'), label + ': streamed events differ from current public source');
  }
  assert.equal(previousCount, expectedPreviousCount, 'All recorded response references must remain navigable.');
  console.log(`Verified all ${experiments.length} experiments / ${stages.length} stages: complete inputs, roles, content blocks, tools, output objects, completion events, client/upstream snapshots; ${previousCount} response references.`);

  let supplementalCount = 0;
  for (const experiment of experiments) {
    for (const kind of ['auditFile', 'hookEventsFile', 'rolloutEventsFile', 'fileObservationsFile']) {
      if (!experiment[kind]) continue;
      const host = await openWorkbench(experiment, 0, 'raw', { kind });
      assert.equal(await host.locator('.raw-select').inputValue(), kind, experiment.id + ': supplemental kind must remain selected.');
      assert.equal(await host.locator('[data-raw-content]').textContent(), await readFile(experiment[kind], 'utf8'), experiment.id + ': supplemental evidence changed.');
      if (experiment.submission?.method) assert.equal(await host.locator('[data-submission-method]').getAttribute('data-submission-method'), experiment.submission.method);
      if (experiment.submission?.method === 'codex-app-create-thread') assert.ok((await host.locator('[data-submission-method]').innerText()).includes('不能作为普通输入框'));
      if (experiment.coverage === 'text-progress-only') assert.ok((await host.locator('.experiment-summary').innerText()).includes('清单属于文字进度'));
      supplementalCount++;
    }
  }
  console.log(`Verified ${supplementalCount} supplemental audit, Hook, rollout and file-observation records, including submission paths and the ordinary-task plan limitation.`);

  const fix = experiments.find(item => item.id === '07-fix');
  await page.goto(url + '#/lesson/03-agent-loop');
  await waitChapter('03-agent-loop');
  const timeline = page.locator('#agent-loop-timeline');
  await timeline.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#agent-loop-timeline')?.getAttribute('aria-busy') === 'false');
  assert.equal(await timeline.locator('[data-loop-select]').count(), 5);
  const fixRequests = await Promise.all(fix.stages.map(stage => readJson(stage.requestFile)));
  const fixOutputs = await Promise.all(fix.stages.map(stage => readJson(stage.outputItemsFile)));
  const userText = fixRequests[0].input.find(item => item.role === 'user').content.map(block => block.text || '').join('');
  assert.equal(await timeline.locator('[data-loop-user-text]').textContent(), userText, 'Timeline user input must preserve the actual source.');
  for (let index = 0; index < fix.stages.length; index++) {
    await timeline.locator(`[data-loop-select="${index}"]`).click();
    const panel = timeline.locator(`[data-loop-panel="${index}"]`);
    await panel.waitFor({ state: 'visible' });
    assert.equal(await timeline.locator('[data-loop-panel]:visible').count(), 1);
    assert.equal(await timeline.locator(`[data-loop-select="${index}"]`).getAttribute('aria-selected'), 'true');
    assert.equal(await panel.locator('[data-loop-input]').textContent(), JSON.stringify(fixRequests[index].input, null, 2), 'Timeline must preserve every original input item.');
    const call = fixOutputs[index].items.find(item => item.call_id && /call$/.test(item.type));
    if (call) {
      assert.equal(await panel.locator('[data-loop-call-id]').getAttribute('data-loop-call-id'), call.call_id);
      assert.equal(await panel.locator('[data-loop-call-input]').textContent(), call.input, 'Timeline call code was truncated or changed.');
      const result = fixRequests[index + 1].input.find(item => item.call_id === call.call_id);
      assert.ok(result, 'Timeline source must have a matching next-request result.');
      assert.equal(await panel.locator('[data-loop-result-call-id]').getAttribute('data-loop-result-call-id'), result.call_id);
      assert.equal(await panel.locator('[data-loop-result-call-id]').getAttribute('data-loop-result-stage'), String(index + 1));
      assert.equal(await panel.locator('[data-loop-result-item]').textContent(), JSON.stringify(result, null, 2), 'Timeline return object was truncated or changed.');
    } else assert.equal(await panel.locator('[data-loop-call-id]').count(), 0, 'The final answer must not invent an extra tool call.');
    for (const view of ['request', 'output', 'calls', 'raw']) {
      await panel.locator(`.loop-evidence-links [data-loop-view="${view}"][data-loop-stage="${index}"]`).click();
      const selected = await waitWorkbench('03-agent-loop', fix.id, index, view);
      if (view === 'request') await verifyItems(selected, fixRequests[index].input, 'input', `timeline ${index}: input link`);
      if (view === 'output') await verifyItems(selected, fixOutputs[index].items, 'output', `timeline ${index}: output link`);
      if (view === 'raw') assert.equal(await selected.locator('[data-raw-content]').textContent(), await readFile(fix.stages[index].requestFile, 'utf8'), 'Timeline raw link selected the wrong source.');
      if (view === 'calls' && call) {
        const pair = selected.locator('.call-pair').filter({ has: page.locator('h4').filter({ hasText: call.call_id }) });
        const originals = (await pair.locator('[data-call-item]').allTextContents()).map(text => JSON.parse(text));
        assert.ok(originals.some(item => JSON.stringify(item) === JSON.stringify(call)), 'Timeline call view omitted the actual model call.');
        const result = fixRequests[index + 1].input.find(item => item.call_id === call.call_id);
        assert.ok(originals.some(item => JSON.stringify(item) === JSON.stringify(result)), 'Timeline call view omitted its actual next-request result.');
      }
    }
    if (call) {
      await panel.locator('[data-loop-result-link]').click();
      const selected = await waitWorkbench('03-agent-loop', fix.id, index + 1, 'request');
      const result = selected.locator('.trace-item[data-item-path="input[0]"]');
      assert.ok(await result.evaluate(element => element.open), 'Timeline return link must reveal the result input.');
      assert.ok((await result.innerText()).includes(call.call_id));
    }
  }
  const finalText = fixOutputs.at(-1).items.filter(item => item.type === 'message' && item.role === 'assistant').flatMap(item => item.content || []).map(block => block.text || '').join('');
  assert.equal(await timeline.locator('[data-loop-final-text]').textContent(), finalText);
  const checks = fixRequests.at(-1).input[0].output.slice(1).map(block => JSON.parse(block.text));
  for (const command of ['npm run typecheck', 'npm test', 'npm start']) {
    const expected = checks.find(check => check.check === command);
    assert.equal(await timeline.locator(`[data-loop-check="${command}"]`).getAttribute('data-loop-exit-code'), String(expected.value.exit_code));
  }
  assert.equal(await timeline.locator('[data-loop-program-output]').textContent(), checks.find(check => check.check === 'npm start').value.output);
  console.log('Verified five real Agent Loop stages, four call/result identities, every timeline view link, result jumps, original prompt/final text and three check outputs.');

  const hello = experiments.find(item => item.id === '01-hello');
  let host = await openWorkbench(hello, 1, 'request');
  const request = await readJson(hello.stages[1].requestFile);
  await host.locator('[data-expand-inputs]').click();
  assert.ok(await host.locator('[data-full-content]').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize)) >= 13, 'Desktop full-text source font is too small.');
  const block = host.locator('[data-content-path="input[5].content[1]"]');
  await block.locator(':scope > .code-panel [data-copy]').click();
  const copiedText = await page.evaluate(() => navigator.clipboard.readText());
  // Windows clipboard converts LF into CRLF; verify every other character and
  // every line, while the DOM checks above remain byte-for-character exact.
  assert.ok(copiedText.replace(/\r\n/g, '\n') === request.input[5].content[1].text.replace(/\r\n/g, '\n'), 'Copied AGENTS/environment text changed beyond native clipboard line endings.');
  await block.locator('summary').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'work/site-input-fulltext-desktop.png', fullPage: false, animations: 'disabled' });
  await host.locator('[data-share]').click();
  const share = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(share.includes('experiment=01-hello') && share.includes('stage=1'));
  await page.reload(); await page.locator('#main[aria-busy="false"]').waitFor();
  await waitWorkbench('01-request', '01-hello', 1, 'request');
  assert.equal(await page.locator('[data-workbench="01-request"] .stage-select').inputValue(), '1');
  host = await openWorkbench(hello, 1, 'request', { input: '5', content: '1' });
  await page.reload();
  host = await waitWorkbench('01-request', '01-hello', 1, 'request');
  assert.ok(await host.locator('[data-item-path="input[5]"]').evaluate(element => element.open));
  assert.ok(await host.locator('[data-content-path="input[5].content[1]"]').evaluate(element => element.open), 'A refreshed content bookmark must expand its exact block.');
  assert.equal(await host.locator('[data-full-content="input[5].content[1]"]').textContent(), request.input[5].content[1].text);

  host = await openWorkbench(hello, 1, 'raw', { kind: 'requestFile' });
  const [download] = await Promise.all([page.waitForEvent('download'), host.locator('[data-download]').click()]);
  const downloadedChunks = [];
  for await (const chunk of await download.createReadStream()) downloadedChunks.push(chunk);
  assert.equal(download.suggestedFilename(), hello.stages[1].requestFile.split('/').at(-1));
  assert.equal(sha(Buffer.concat(downloadedChunks)), sha(await readFile(hello.stages[1].requestFile)), 'Downloaded source must preserve the complete original bytes');

  const readme = experiments.find(item => item.id === '03-readme');
  host = await openWorkbench(readme, 0, 'calls');
  assert.ok((await host.locator('.call-pair').innerText()).includes('call_'));
  assert.ok(await host.locator('[data-call-item]').count() >= 2, 'Tool call was not paired with its result.');
  const interrupted = experiments.find(item => item.status === 'interrupted');
  host = await openWorkbench(interrupted, 1, 'calls');
  assert.ok((await host.locator('.experiment-summary').innerText()).includes('已中断'));
  await host.locator('.conversation > summary').click();
  assert.ok((await host.locator('.experiment-summary').innerText()).includes('没有最终回复'));
  assert.ok((await host.locator('.workbench-content').innerText()).includes('20-resume'), 'Interrupted tool result must link across experiments.');
  host = await openWorkbench(interrupted, 1, 'raw', { kind: 'interruptionFile' });
  assert.ok((await host.locator('[data-raw-content]').innerText()).includes('turn_aborted'));
  const compact = experiments.find(item => item.requestKind === 'compaction');
  host = await openWorkbench(compact, 0, 'raw', { kind: 'compactionFile' });
  assert.ok((await host.locator('[data-raw-content]').innerText()).includes('replacement_history'));
  const plan = experiments.find(item => item.id === '14-plan');
  host = await openWorkbench(plan, 0, 'request');
  await host.locator('.conversation > summary').click();
  assert.ok((await host.locator('.conversation').innerText()).includes('没有普通最终回复'));
  const child = experiments.find(item => item.id === '16-agent-a');
  host = await openWorkbench(child, 0, 'request');
  await host.locator('.conversation > summary').click();
  assert.ok((await host.locator('.experiment-summary').innerText()).includes('由父任务委派'));
  const goal = experiments.find(item => item.id === '17-goal');
  host = await openWorkbench(goal, 0, 'request');
  await host.locator('.conversation > summary').click();
  assert.ok((await host.locator('.experiment-summary').innerText()).includes('通过原生 Goal 入口设置目标'));
  assert.ok(!(await host.locator('.experiment-summary').innerText()).includes('由父任务委派'), 'A native Goal input must not be labelled as child-agent delegation.');

  for (const [lessonId, path] of [['introduction', 'evidence/desktop-lab/index.json'], ['10-permissions', 'evidence/desktop-lab/15-permissions/runtime-context.json'], ['12-multi-agent', 'evidence/desktop-lab/16-multi-agent/collaboration.json'], ['13-autonomy', 'evidence/desktop-lab/17-goal/goal-state.json']]) {
    await page.goto(url + '#/lesson/' + lessonId + '?file=' + encodeURIComponent(path));
    const supplement = page.locator('#supplement-' + lessonId);
    await supplement.locator('[data-supplement-content]').waitFor({ state: 'visible' });
    assert.ok(await supplement.locator('[data-supplement-content]').textContent() === await readFile(path, 'utf8'), path + ': supplemental source changed');
    if (lessonId === 'introduction') assert.ok(page.url().includes('#/guide?file='), 'The previous introduction evidence link must migrate to the guide.');
    else await waitChapter(lessonId);
  }
  await page.locator('#chapter-search').fill('call_id');
  await page.locator('#search-results a.search-result').first().waitFor();
  assert.equal(await page.locator('#chapter-nav').isVisible(), false);
  await page.locator('#chapter-search').fill('');
  await page.locator('#chapter-nav').waitFor();
  await page.goto(url + '#/lesson/15-architecture');
  await waitChapter('15-architecture');
  const architectureDiagram = page.locator('#chapter-15-architecture .mermaid');
  await architectureDiagram.locator('svg').waitFor({ state: 'visible' });
  assert.ok(await architectureDiagram.locator('svg').evaluate(svg => svg.getBoundingClientRect().width >= svg.viewBox.baseVal.width - 1), 'Architecture diagram text must retain its intrinsic scale.');
  await page.getByRole('button', { name: '切换深浅主题' }).click();
  assert.ok(await page.locator('html').evaluate(element => element.classList.contains('dark')));
  assert.equal(await architectureDiagram.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(250, 250, 250)', 'Neutral diagram must retain a readable light background in dark mode.');
  assert.ok(await architectureDiagram.evaluate(element => [...element.querySelectorAll('.nodeLabel p,.edgeLabel p')].every(label => Math.max(...getComputedStyle(label).color.match(/\d+/g).slice(0, 3).map(Number)) < 140)), 'Diagram labels must remain dark on the light canvas after a theme toggle.');
  await noOverflow('Dark architecture chapter');
  const darkCode = page.locator('.code-panel').first();
  assert.ok(await darkCode.evaluate(element => Math.max(...getComputedStyle(element).backgroundColor.match(/\d+/g).slice(0, 3).map(Number)) < 70), 'Dark-mode code must remain dark.');
  await page.goto(url + '#/');
  await page.locator('.home-page:visible').waitFor();
  await page.screenshot({ path: 'work/site-reader-dark.png', fullPage: false });
  await page.getByRole('button', { name: '切换深浅主题' }).click();
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(url + '#/'); await page.locator('.home-page:visible').waitFor(); await noOverflow(`${width}px homepage`);
    await page.goto(url + '#/guide'); await page.locator('.introduction:visible').waitFor(); await noOverflow(`${width}px guide`);
    for (const lesson of catalog.lessons) { await page.goto(url + '#/lesson/' + lesson.id); await waitChapter(lesson.id); await noOverflow(`${width}px ${lesson.id}`); }
    host = await openWorkbench(hello, 1, 'request'); await noOverflow(`${width}px structured input`);
    assert.ok(await host.locator('[data-full-content]').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize)) >= 12, 'Mobile full-text source font is too small.');
    assert.equal(await page.locator('.chapter-outline').count(), 1, 'Responsive reading must keep a single outline.');
    if (width === 390) await page.getByRole('button', { name: '展开学习目录' }).click();
    await page.locator('.chapter-outline a[data-section]').first().click();
    if (width === 390) assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'), 'false', 'A section jump must close the mobile menu.');
    await waitChapter('01-request');
    await noOverflow(`${width}px chapter heading jump`);
    if (width === 390) {
      await page.goto(url + '#/lesson/10-hooks'); await waitChapter('10-hooks');
      await page.screenshot({ path: 'work/site-hooks-mobile.png', fullPage: false, animations: 'disabled' });
      await page.goto(url + '#/lesson/01-request'); await waitChapter('01-request');
      await page.screenshot({ path: 'work/site-chapter-mobile.png', fullPage: false, animations: 'disabled' });
      await page.getByRole('button', { name: '展开学习目录' }).click();
      assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'), 'true');
      await page.screenshot({ path: 'work/site-directory-mobile.png', fullPage: false, animations: 'disabled' });
      await page.locator('.course-sidebar a[href="#/guide"]').click();
      await page.locator('.introduction:visible').waitFor();
      assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'), 'false');
      await page.goto(url + '#/lesson/15-architecture'); await waitChapter('15-architecture');
      assert.ok(await architectureDiagram.evaluate(element => element.scrollWidth > element.clientWidth), 'Wide mobile diagram must scroll inside its frame.');
      assert.ok(await architectureDiagram.locator('svg').evaluate(svg => svg.getBoundingClientRect().width >= svg.viewBox.baseVal.width - 1), 'Mobile diagram must retain its intrinsic scale.');
      await noOverflow('Mobile architecture diagram');
      await page.goto(url + '#/lesson/03-agent-loop?section=agent-loop-timeline'); await waitChapter('03-agent-loop');
      await noOverflow('Mobile Agent Loop timeline');
      await page.screenshot({ path: 'work/site-timeline-mobile.png', fullPage: false, animations: 'disabled' });
      await page.goto(url + '#/'); await page.locator('.home-page:visible').waitFor();
      await page.screenshot({ path: 'work/site-reader-mobile.png', fullPage: false, animations: 'disabled' });
      await openWorkbench(hello, 1, 'request'); await page.screenshot({ path: 'work/site-workbench-mobile.png', fullPage: false, animations: 'disabled' });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url + '#/lesson/10-permissions'); await waitChapter('10-permissions');
  const permissionImage = page.locator('#chapter-10-permissions .prose img').first();
  await permissionImage.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'work/site-permission-desktop.png', fullPage: false, animations: 'disabled' });
  const permissionPopup = context.waitForEvent('page');
  await permissionImage.locator('..').click();
  const permissionOriginal = await permissionPopup;
  await permissionOriginal.waitForLoadState();
  assert.equal(permissionOriginal.url(), await permissionImage.locator('..').getAttribute('href'));
  await permissionOriginal.screenshot({ path: 'work/site-permission-original.png', fullPage: false });
  await permissionOriginal.close();
  await page.setViewportSize({ width: 390, height: 844 });
  await permissionImage.scrollIntoViewIfNeeded();
  await noOverflow('Mobile permissions screenshot');
  await page.screenshot({ path: 'work/site-permission-mobile.png', fullPage: false, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url + '#/lesson/10-hooks'); await waitChapter('10-hooks');
  const desktopScreenshot = page.locator('#chapter-10-hooks .prose img').last();
  await desktopScreenshot.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'work/site-screenshot-in-article.png', fullPage: false, animations: 'disabled' });
  await openWorkbench(hello, 1, 'request'); await page.screenshot({ path: 'work/site-workbench-desktop.png', fullPage: false, animations: 'disabled' });
  await checkReading(page, url);
  await writeFile('work/site-browser-errors.json', JSON.stringify({ errors, badResources }, null, 2) + '\n');
  assert.deepEqual(errors, [], 'Browser errors must not be swallowed.');
  assert.deepEqual(badResources, [], 'Deployed-path assets must all load without failed requests.');
  console.log(`Site checks passed at ${basePath}: four-phase/${catalog.lessons.length}-card homepage, independent Hooks chapter and preserved bookmarks; separate guide and one visible chapter; chapter navigation/history, lazy-load race, all 20 legacy routes and intro aliases; ${foldedHeadings.length} folded headings; five-stage real timeline; all ${stages.length} full-evidence stages and ${previousCount} response links; copy/share and input/content refresh; native records, original image and license; 3 widths and dark theme; no overflow, resource or console errors.`);
} catch (error) {
  const failedPage = browser?.contexts()[0]?.pages()[0];
  if (failedPage && !failedPage.isClosed()) {
    await mkdir('work', { recursive: true });
    await failedPage.screenshot({ path: 'work/site-check-failure.png', fullPage: false, animations: 'disabled' }).catch(() => {});
  }
  throw error;
} finally { await browser?.close(); server.close(); }
