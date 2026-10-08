// Run with Playwright available on NODE_PATH; no website build is required.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const screenshotDir = process.env.SCREENSHOT_DIR;
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.txt':'text/plain; charset=utf-8', '.svg':'image/svg+xml', '.ttf':'font/ttf' };
const server = http.createServer((req, res) => {
  let file;
  try { file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname)); }
  catch (_) { res.writeHead(400).end(); return; }
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, content) => {
    if (error) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  });
});
let browser;
const results = [];
function check(name, condition) { assert.ok(condition, name); results.push(name); }
async function simulate(page, value) {
  await page.keyboard.press('Control+Alt+d');
  await page.locator('#dev-time').fill(value.replace(/:00$/, ''));
  await page.locator('#dev-form button[type=submit]').click();
  await page.locator('#dev-close').click();
  await page.waitForTimeout(350);
}
async function noOverflow(page, name) {
  const overflow = await page.evaluate(() => {
    const elements = [document.documentElement, document.querySelector('.card'), document.querySelector('#calendar-dialog'), document.querySelector('.calendar-inner')];
    return elements.filter(e => e && (e.offsetWidth || e.offsetHeight)).map(e => ({ tag:e.id || e.className || e.tagName, width:e.clientWidth, scroll:e.scrollWidth })).filter(e => e.scroll > e.width + 1);
  });
  check(name, overflow.length === 0 || (console.log(overflow), false));
}
async function shot(page, name) {
  if (screenshotDir) { fs.mkdirSync(screenshotDir, { recursive:true }); await page.screenshot({ path:path.join(screenshotDir, name + '.png'), fullPage:true }); }
}
(async () => {
  const original = execFileSync('git', ['show','df29141:index.html'], { cwd:root, encoding:'utf8' });
  const current = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const [name, pattern] of [
    ['Original styles preserved', /<style>[\s\S]*?<\/style>/],
    ['Original exam countdown markup preserved', /<section class="countdown"[\s\S]*?<\/section>/],
    ['Original clock calculation preserved', /  function updateClock\(\) \{[\s\S]*?\n  \}/]
  ]) check(name, original.match(pattern)[0].replace(/\r/g,'') === current.match(pattern)[0].replace(/\r/g,''));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless:true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath:process.env.BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport:{ width:1440, height:1000 }, timezoneId:'America/New_York', reducedMotion:'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://utctime.app/api/now', route => route.fulfill({ json:{ unix_ms:Date.parse('2026-10-08T12:00:00+08:00') } }));
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('sentence').textContent !== '正在载入…');
  check('Beijing date despite New York device timezone', await page.locator('#date').textContent() === '10-08');
  check('Both calendar entry buttons have transparent idle backgrounds', await page.locator('#calendar-open, #calendar-open-back').evaluateAll(es => es.every(e => getComputedStyle(e).backgroundColor === 'rgba(0, 0, 0, 0)')));
  await page.locator('#calendar-open').hover();
  check('Calendar entry has distinct hover feedback', await page.locator('#calendar-open').evaluate(e => getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)'));
  await page.locator('#archive summary').click();
  await page.waitForFunction(() => document.querySelectorAll('#archive-list li').length > 0);
  check('Archive scrollbar is hidden while scrolling still works', await page.locator('#archive-list').evaluate(e => {
    e.scrollTop = 100;
    return getComputedStyle(e).scrollbarWidth === 'none' && getComputedStyle(e, '::-webkit-scrollbar').display === 'none' && e.scrollTop > 0;
  }));
  await page.locator('#archive summary').click();
  await shot(page, '01-original-with-additions');
  await page.locator('#card-flip').click();
  await page.waitForFunction(() => !document.getElementById('card-back').hidden);
  check('Midnight countdown uses shared Beijing clock', /^11:59:5\d|12:00:00/.test(await page.locator('#midnight-countdown').textContent()));
  check('Day remaining at noon is 50 percent', Math.abs(Number(await page.locator('#day-progress').getAttribute('aria-valuenow')) - 50) < .1);
  check('Clock has hands, ticks and a 24-hour face', await page.locator('.clock-hand').count() === 3 && await page.locator('#clock-ticks path').count() === 60 && (await page.locator('.clock-numbers').textContent()).includes('24'));
  check('Reduced motion disables sprint animations', await page.locator('#day-progress .sprint-remaining').evaluate(e => getComputedStyle(e, '::before').animationName === 'none'));
  check('Back page keeps only enlarged daily heading', (await page.locator('#back-title').textContent()) === '今日余量' && await page.locator('#back-title').evaluate(e => parseFloat(getComputedStyle(e).fontSize) >= 30) && !/让今天，慢慢充实|哪怕只向前一步/.test(await page.locator('#card-back').textContent()));
  check('Remaining day segment is brighter than completed segment', await page.locator('#day-progress').evaluate(e => getComputedStyle(e).backgroundColor !== getComputedStyle(e.querySelector('.sprint-fill')).backgroundColor));
  await shot(page, '02-card-reverse');
  await page.locator('#card-unflip').click();
  await page.locator('#calendar-open').click();
  await page.waitForFunction(() => !document.getElementById('quote-copy').disabled);
  check('Both exam days keep independent distances', /72/.test(await page.locator('#exam-first-distance').textContent()) && /73/.test(await page.locator('#exam-second-distance').textContent()));
  check('Today and past cells distinguished', await page.locator('.cal-day.is-today').count() === 1 && await page.locator('.cal-day.is-past').count() === 7);
  check('October sprint period connects today through month end', await page.locator('.cal-day.is-range').count() === 24 && await page.locator('.cal-day.range-start').count() === 1);
  check('Only today and earlier dates show readable quote markers', await page.locator('.cal-day.has-quote').count() === 8 && await page.locator('[data-date="2026-10-09"].has-quote').count() === 0);
  check('Calendar bar moves right with a small illustrative note and no percentage', /仅作时间示意/.test(await page.locator('#journey-label').textContent()) && !/%|考前还剩/.test(await page.locator('#journey-label').textContent()) && Number(await page.locator('#journey-progress').getAttribute('aria-valuenow')) > 75 && await page.locator('#journey-label').evaluate(e => parseFloat(getComputedStyle(e).fontSize) <= 12));
  check('Range bands sit below date buttons without intercepting clicks', await page.locator('.day-grid').evaluate(grid => {
    const band = grid.querySelector('.range-band');
    const day = grid.querySelector('.cal-day.is-range');
    return band && Number(getComputedStyle(band).zIndex) < Number(getComputedStyle(day).zIndex) && getComputedStyle(band).pointerEvents === 'none' && getComputedStyle(day, '::before').content === 'none';
  }));
  check('Calendar footer instruction is removed', await page.locator('.calendar-footnote').count() === 0);
  const rangeCell = page.locator('[data-date="2026-10-09"]');
  const normalCellStyle = await rangeCell.evaluate(e => [getComputedStyle(e).backgroundColor,getComputedStyle(e).borderColor].join('|'));
  await rangeCell.hover();
  check('Hover highlights a sprint-period date without changing selection', (await rangeCell.evaluate(e => [getComputedStyle(e).backgroundColor,getComputedStyle(e).borderColor].join('|'))) !== normalCellStyle && await page.locator('#selected-date').textContent() === '2026.10.08');
  await shot(page, '09-hover-range');
  await shot(page, '08-current-sprint-range');
  await page.locator('#cal-exam').click();
  check('Exam dates visible and distinct', await page.locator('.cal-day.is-exam').count() === 2 && await page.locator('.cal-day.is-exam').first().textContent() !== await page.locator('.cal-day.is-exam').last().textContent());
  check('Selected exam retains full fill above the ribbon', await page.locator('.cal-day.is-exam.is-selected').evaluate(e => getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)' && Number(getComputedStyle(e).zIndex) > Number(getComputedStyle(e.parentElement.querySelector('.range-band')).zIndex)));
  check('Future exam quote stays locked and cannot be copied', (await page.locator('#selected-quote').textContent()).includes('留到当天') && await page.locator('#quote-copy').isDisabled() && !(await page.locator('#selected-quote').textContent()).includes('今天上场'));
  check('Future exam cells hide quote markers', await page.locator('.cal-day.is-exam.has-quote').count() === 0);
  check('Post-exam cells are muted without past labels', await page.locator('.cal-day.is-outside').count() === 11 && !(await page.locator('.cal-day.is-outside').allTextContents()).join('').includes('已过'));
  await shot(page, '03-december-month');
  await page.locator('[data-calendar-view=year]').click();
  check('Year overview has twelve clickable months', await page.locator('.cal-month-preview').count() === 12);
  check('Year overview keeps both exam markers', await page.locator('.mini-grid .is-exam').count() === 2);
  check('Year navigation stays fixed in 2026', await page.locator('#cal-prev').isDisabled() && await page.locator('#cal-next').isDisabled());
  check('Miniature date labels also sit above range bands', await page.locator('.mini-grid .is-exam').first().evaluate(e => Number(getComputedStyle(e).zIndex) > Number(getComputedStyle(e.parentElement.querySelector('.range-band')).zIndex)));
  await shot(page, '04-year-overview');
  await page.locator('[data-calendar-view=quarter]').click();
  check('Quarter overview renders three months', await page.locator('.cal-month').count() === 3);
  await page.locator('[data-calendar-view=month]').click();
  await page.locator('#quote-next').click();
  check('Next future day remains locked', (await page.locator('#selected-date').textContent()).includes('20') && await page.locator('#quote-copy').isDisabled());
  await page.locator('#quote-today').click();
  await page.waitForFunction(() => !document.getElementById('quote-copy').disabled);
  check('Read today shortcut restores available quote', await page.locator('#selected-date').textContent() === '2026.10.08');
  await page.keyboard.press('Escape');
  check('Dialog returns keyboard focus', await page.locator('#calendar-open').evaluate(e => e === document.activeElement));
  await simulate(page, '2026-10-08T23:59:58');
  await page.locator('#card-flip').click();
  await page.waitForFunction(() => document.getElementById('date').textContent === '10-09', { timeout:6000 });
  await page.waitForTimeout(350);
  check('Midnight rollover resets rightward progress and refills countdown', Number(await page.locator('#day-progress').getAttribute('aria-valuenow')) < .1 && /^(24:00:00|23:59:5\d)$/.test(await page.locator('#midnight-countdown').textContent()));
  await page.locator('#card-unflip').click();
  await simulate(page, '2026-12-19T08:30:00');
  check('Original exam timer still stops at target', (await page.locator('#countdown').textContent()).replace(/\D/g,'') === '00000000');
  await page.locator('#calendar-open').click();
  await page.waitForTimeout(1100);
  check('On first exam day the second day remains one day away', /今天|今日/.test(await page.locator('#exam-first-distance').textContent()) && /1/.test(await page.locator('#exam-second-distance').textContent()));
  await page.locator('#cal-today').click();
  check('Exam-day quote unlocks on its own date', (await page.locator('#selected-quote').textContent()).includes('今天上场') && await page.locator('#quote-copy').isEnabled());
  await page.keyboard.press('Escape');
  await simulate(page, '2026-12-21T00:00:00');
  await page.locator('#calendar-open').click();
  await page.waitForTimeout(1100);
  check('After exams both distances show past days', /已过.*2|2.*已过/.test(await page.locator('#exam-first-distance').textContent()) && /已过.*1|1.*已过/.test(await page.locator('#exam-second-distance').textContent()));
  await page.locator('#cal-today').click();
  check('Selected post-exam date has natural wording without negative numbers', !/-\d/.test(await page.locator('#selected-distance').textContent()) && /已过 2 天/.test(await page.locator('#selected-distance').textContent()));
  check('Post-exam bar reaches finish and stops animation', Number(await page.locator('#journey-progress').getAttribute('aria-valuenow')) === 100 && !(await page.locator('#journey-progress').getAttribute('class')).includes('is-running'));
  check('Post-exam dates never say past on their cells', !(await page.locator('.cal-day.is-outside').allTextContents()).join('').includes('已过'));
  await page.keyboard.press('Escape');
  await simulate(page, '2026-10-08T12:00:00');
  for (const width of [320,375,540,768,1024,1440]) {
    await page.setViewportSize({ width, height:width < 540 ? 667 : 1000 });
    await noOverflow(page, width + 'px card has no horizontal overflow');
    await page.locator('#card-flip').click();
    await noOverflow(page, width + 'px reverse has no horizontal overflow');
    if (width === 320) await shot(page, '05-mobile-reverse');
    await page.locator('#card-unflip').click();
    await page.locator('#calendar-open').click();
    await page.locator('#cal-exam').click();
    for (const view of ['month','quarter','year']) {
      await page.locator('[data-calendar-view=' + view + ']').click();
      await noOverflow(page, width + 'px ' + view + ' calendar has no horizontal overflow');
      if (width === 375 && view === 'month') await shot(page, '06-mobile-calendar');
    }
    await page.keyboard.press('Escape');
  }
  await page.locator('#theme-toggle').click();
  await page.locator('#calendar-open').click();
  await page.locator('#cal-exam').click();
  await page.locator('[data-calendar-view=month]').click();
  await shot(page, '07-dark-calendar');
  check('No browser runtime errors', errors.length === 0 || (console.log(errors), false));

  // Exercise normal animation, keyboard navigation, and independent source recovery.
  const normal = await browser.newContext({ viewport:{width:1100,height:900}, timezoneId:'UTC' });
  const interactive = await normal.newPage();
  interactive.on('pageerror', error => errors.push(error.message));
  let legacyFailure = true;
  await interactive.route('https://utctime.app/api/now', route => route.fulfill({json:{unix_ms:Date.parse('2026-10-08T12:00:00+08:00')}}));
  await interactive.route(url => decodeURIComponent(url.pathname).includes('古早版'), route => legacyFailure ? route.fulfill({status:503,body:'Unavailable'}) : route.continue());
  await interactive.goto(url);
  await interactive.locator('#card-flip').click();
  await interactive.waitForFunction(() => document.activeElement === document.getElementById('back-title'), null, {timeout:5000});
  check('Normal flip animation reveals back and moves focus', await interactive.locator('#back-title').evaluate(e => !e.closest('[hidden]') && document.activeElement === e));
  const secondAngle = await interactive.locator('#clock-second').evaluate(e => Number(e.style.transform.match(/rotate\(([-.\d]+)deg\)/)[1]));
  await interactive.waitForTimeout(500);
  check('Countdown clock hands move backwards', await interactive.locator('#clock-second').evaluate(e => Number(e.style.transform.match(/rotate\(([-.\d]+)deg\)/)[1])) < secondAngle);
  check('Daily remaining segment carries active moving lanes', await interactive.locator('#day-progress .sprint-remaining').evaluate(e => getComputedStyle(e, '::before').animationName === 'day-lanes'));
  check('Daily sprint marker has its own beat and forward arrow', await interactive.locator('#day-marker').evaluate(e => getComputedStyle(e).animationName === 'day-beat' && getComputedStyle(e, '::before').animationName === 'day-arrow'));
  await interactive.locator('#card-unflip').click();
  await interactive.waitForFunction(() => {
    const transform = getComputedStyle(document.querySelector('.card')).transform;
    return document.activeElement === document.getElementById('card-flip') && (transform === 'none' || new DOMMatrix(transform).isIdentity);
  }, null, {timeout:5000});
  check('Flip returns with no leftover transform', await interactive.locator('.card').evaluate(e => e.getAnimations().every(a => a instanceof CSSAnimation)) && await interactive.locator('#card-flip').evaluate(e => document.activeElement === e));
  await interactive.locator('#calendar-open').click();
  await interactive.waitForFunction(() => !document.getElementById('quote-copy').disabled);
  check('Calendar uses a slow soft glint distinct from daily lanes', await interactive.locator('#journey-progress .sprint-remaining').evaluate(e => getComputedStyle(e, '::before').animationName === 'calendar-glide' && parseFloat(getComputedStyle(e, '::before').animationDuration) >= 4));
  check('Calendar keeps the daily warm palette and emphasizes the remaining segment', await interactive.locator('#journey-progress').evaluate(e => getComputedStyle(e).getPropertyValue('--remaining-color').trim() === getComputedStyle(document.getElementById('day-progress')).getPropertyValue('--remaining-color').trim() && getComputedStyle(e.querySelector('.sprint-remaining')).backgroundImage !== 'none'));
  check('Readable quote hides unrelated loading details', (await interactive.locator('#selected-meta').textContent()).includes('今日一句') && await interactive.locator('#quote-retry').isHidden() && !/古早|83 天|另一段|两段/.test(await interactive.locator('.quote-panel').textContent()));
  check('Calendar uses a slim themed scrollbar', await interactive.locator('#calendar-dialog').evaluate(e => getComputedStyle(e).scrollbarWidth === 'thin'));
  await interactive.locator('[data-date="2026-10-31"]').click();
  await interactive.keyboard.press('ArrowRight');
  check('Keyboard crosses month and retains selected focus', await interactive.locator('#selected-date').textContent() === '2026.11.01' && await interactive.locator('[data-date="2026-11-01"]').evaluate(e => e === document.activeElement));
  await interactive.locator('[data-calendar-view=year]').click();
  await interactive.locator('[data-month="0"]').click();
  await interactive.locator('[data-date="2026-01-01"]').click();
  check('Failed legacy section shows actionable error', (await interactive.locator('#selected-quote').textContent()).includes('没能加载') && await interactive.locator('#quote-copy').isDisabled());
  check('Load failure does not expose how data is assembled', !/古早|83 天|另一段|两段|拼接/.test(await interactive.locator('.quote-panel').textContent()));
  legacyFailure = false;
  await interactive.locator('#quote-retry').click();
  await interactive.waitForFunction(() => !document.getElementById('quote-copy').disabled);
  check('Retry recovers only failed source', (await interactive.locator('#selected-quote').textContent()).includes('理想从行动里生根') && await interactive.locator('#quote-retry').isHidden());
  check('January and quote navigation cannot move into 2025', await interactive.locator('#cal-prev').isDisabled() && await interactive.locator('#quote-prev').isDisabled());
  await interactive.locator('[data-date="2026-01-01"]').focus();
  await interactive.keyboard.press('ArrowLeft');
  check('Keyboard cannot cross the first 2026 date', await interactive.locator('#selected-date').textContent() === '2026.01.01');
  await interactive.locator('[data-calendar-view=quarter]').click();
  check('First quarter cannot navigate to 2025', await interactive.locator('#cal-prev').isDisabled());
  await interactive.locator('[data-calendar-view=month]').click();
  await interactive.keyboard.press('Escape');
  await simulate(interactive, '2026-10-08T23:59:58');
  await interactive.locator('#calendar-open').click();
  await interactive.locator('#cal-today').click();
  await interactive.waitForFunction(() => document.getElementById('selected-date').textContent === '2026.10.09', null, {timeout:6000});
  check('Open calendar follows today across Beijing midnight', await interactive.locator('[data-date="2026-10-09"]').evaluate(e => e.classList.contains('is-today') && e.classList.contains('is-selected')));
  await interactive.keyboard.press('Escape');
  await simulate(interactive, '2026-12-31T23:59:58');
  await interactive.locator('#calendar-open').click();
  await interactive.locator('#cal-today').click();
  await interactive.waitForFunction(() => document.getElementById('date').textContent === '2027-01-01', null, {timeout:6000});
  await interactive.waitForTimeout(1100);
  check('Calendar stays in 2026 across year boundary', await interactive.locator('#selected-date').textContent() === '2026.12.31' && await interactive.locator('[data-date^="2027-"]').count() === 0 && await interactive.locator('#cal-next').isDisabled() && await interactive.locator('#quote-next').isDisabled());
  check('Out-of-range today shortcut is disabled', await interactive.locator('#cal-today').isDisabled() && await interactive.locator('#quote-today').isHidden());
  await interactive.locator('[data-date="2026-12-31"]').focus();
  await interactive.keyboard.press('ArrowRight');
  check('Keyboard cannot cross the final 2026 date', await interactive.locator('#selected-date').textContent() === '2026.12.31');
  await interactive.locator('[data-calendar-view=quarter]').click();
  check('Last quarter cannot navigate to 2027', await interactive.locator('#cal-next').isDisabled());
  await interactive.keyboard.press('Escape');
  await simulate(interactive, '2026-10-08T18:00:00');
  await interactive.locator('#card-flip').click();
  await interactive.waitForFunction(() => !document.getElementById('card-back').hidden);
  check('Evening bar moves right to 75 percent while wording says 25 percent remaining', Math.abs(Number(await interactive.locator('#day-progress').getAttribute('aria-valuenow')) - 75) < .1 && /剩余 25/.test(await interactive.locator('#day-percent').textContent()));
  check('No runtime errors in normal motion or boundary cases', errors.length === 0);

  console.log(JSON.stringify({ passed:results.length, checks:results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  server.close();
});
