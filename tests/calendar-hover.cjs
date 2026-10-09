// Browser-level regression cases for sampled pointer paths, invoked by ui-check.cjs.
module.exports = async function calendarHoverChecks(page, check) {
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const reset = async () => {
    await page.locator('[data-calendar-view=month]').click();
    await settle();
  };
  const dates = async () => page.locator('.cal-day.is-hovered').evaluateAll(buttons => buttons.map(button => button.dataset.date).sort());
  const rects = async () => page.locator('.cal-day').evaluateAll(buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect();
    return { date:button.dataset.date, left:rect.left, right:rect.right, top:rect.top, bottom:rect.bottom,
      x:(rect.left + rect.right) / 2, y:(rect.top + rect.bottom) / 2 };
  }));
  const firstWeek = Array.from({length:7}, (_, index) => `2026-06-0${index + 1}`);
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  await page.locator('[data-calendar-view=year]').click();
  await page.locator('[data-month="5"]').click();
  await settle();

  const entrance = await page.locator('[data-date="2026-06-01"]').evaluate(async button => {
    const duration = () => Math.max(...getComputedStyle(button).transitionDuration.split(',').map(Number.parseFloat)) * 1000;
    const idle = duration();
    button.dispatchEvent(new PointerEvent('pointerover', {bubbles:true,pointerType:'mouse'}));
    const entry = duration();
    const animation = button.getAnimations().find(item => item.transitionProperty === 'border-top-color');
    let earlyAlpha = null;
    if (animation) {
      animation.pause();
      animation.currentTime = 16;
      const border = getComputedStyle(button).borderColor;
      earlyAlpha = border.startsWith('rgba(') ? Number.parseFloat(border.split(',')[3]) : border.startsWith('rgb(') ? 1 : null;
    }
    button.dispatchEvent(new PointerEvent('pointerout', {bubbles:true,pointerType:'mouse'}));
    return { idle, entry, earlyAlpha };
  });
  console.log('Calendar hover entrance:', JSON.stringify(entrance));
  check('Date entrance completes within 60ms while exit retains its 180ms fade', entrance.entry <= 60 && entrance.idle === 180);
  check('Date entrance reaches visible feedback in the first 16ms', entrance.earlyAlpha > .75);

  for (const direction of ['forward', 'reverse']) {
    await reset();
    const cells = await rects();
    const first = cells[0];
    const last = cells[6];
    const start = {x:direction === 'forward' ? first.left - 3 : last.right + 3, y:first.y};
    const end = {x:direction === 'forward' ? last.right + 3 : first.left - 3, y:first.y};
    await page.mouse.move(start.x, start.y);
    await page.mouse.move(end.x, end.y, {steps:1});
    check(`One sparse ${direction} pointer jump lights every date in the week`, equal(await dates(), firstWeek));
    check(`Sparse ${direction} sweep preserves the selected date`, await page.locator('#selected-date').textContent() === '2026.10.08');
    await page.waitForTimeout(360);
    check(`Sparse ${direction} sweep clears its entire trail`, (await dates()).length === 0);
  }

  await reset();
  let cells = await rects();
  await page.mouse.move(cells[0].x, cells[0].y);
  await page.mouse.move(cells[6].x, cells[6].y, {steps:1});
  check('Sparse sweep ending inside a date also fills skipped cells', equal(await dates(), firstWeek));
  await page.waitForTimeout(360);
  check('Only the actual endpoint stays hovered after the trail fades', equal(await dates(), ['2026-06-07']));

  await reset();
  cells = await rects();
  await page.mouse.move(cells[3].x, cells[3].y);
  await page.waitForTimeout(300);
  await page.mouse.move(cells[3].right + 2, cells[3].y);
  check('A real mouse departure after a long stay releases without a new trail pulse', (await dates()).length === 0);

  await reset();
  cells = await rects();
  const gap = (cells[0].bottom + cells[7].top) / 2;
  await page.mouse.move(cells[0].left - 3, gap);
  await page.mouse.move(cells[6].right + 3, gap, {steps:1});
  check('A fast sweep through row spacing does not light either adjacent row', (await dates()).length === 0);

  await reset();
  cells = await rects();
  // Vertical paths cross row gaps without lighting adjacent columns.
  await page.mouse.move(cells[0].x, cells[0].top - 3);
  await page.mouse.move(cells[21].x, cells[21].bottom + 3, {steps:1});
  check('Sparse vertical movement lights only the intersected column', equal(await dates(), [1,8,15,22].map(day => `2026-06-${String(day).padStart(2,'0')}`)));

  await reset();
  cells = await rects();
  await page.mouse.move(cells[0].x, cells[0].y);
  await page.mouse.move(cells[27].x, cells[27].y, {steps:1});
  check('Sparse diagonal movement lights intersected cells without filling whole rows', equal(await dates(), [1,2,9,10,11,18,19,20,27,28].map(day => `2026-06-${String(day).padStart(2,'0')}`)));

  await reset();
  cells = await rects();
  await page.mouse.move(cells[0].left - 3, cells[0].y);
  const coalesced = await page.evaluate(cells => {
    const stage = document.getElementById('cal-stage');
    const point = (x, y) => new PointerEvent('pointermove', {bubbles:true,pointerType:'mouse',pointerId:1,clientX:x,clientY:y});
    const event = point(cells[6].right + 3, cells[7].y);
    // Move along the first row, down the outside gutter, then back along the second.
    // Endpoint interpolation alone would cut diagonally across the wrong cells.
    Object.defineProperty(event, 'getCoalescedEvents', {value:() => [
      point(cells[6].right + 3, cells[0].y),
      point(cells[6].right + 3, cells[7].y),
      point(cells[7].left - 3, cells[7].y),
      point(cells[6].right + 3, cells[7].y)
    ]});
    stage.dispatchEvent(event);
    return [...stage.querySelectorAll('.cal-day.is-hovered')].map(button => button.dataset.date).sort();
  }, cells);
  check('Coalesced samples preserve turns instead of replacing the path with a diagonal', equal(coalesced, Array.from({length:14}, (_, index) => `2026-06-${String(index + 1).padStart(2,'0')}`)));

  // Measure the warmed event path and catch accidental layout reads in its loop.
  await reset();
  cells = await rects();
  await page.mouse.move(cells[0].left - 3, cells[0].y);
  const work = await page.evaluate(cells => {
    const original = Element.prototype.getBoundingClientRect;
    let reads = 0;
    Element.prototype.getBoundingClientRect = function (...args) {
      if (this.matches('.cal-day, #calendar-dialog')) reads++;
      return original.apply(this, args);
    };
    const times = [];
    try {
      for (let i = 0; i < 120; i++) {
        const x = i % 2 ? cells[0].left - 3 : cells[6].right + 3;
        const start = performance.now();
        document.getElementById('cal-stage').dispatchEvent(new PointerEvent('pointermove', {
          bubbles:true,pointerType:'mouse',pointerId:1,clientX:x,clientY:cells[0].y
        }));
        times.push(performance.now() - start);
      }
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
    times.sort((a,b) => a - b);
    return { samples:times.length, layoutReads:reads, meanMs:times.reduce((a,b) => a+b, 0)/times.length,
      p95Ms:times[Math.floor(times.length * .95)], maxMs:times.at(-1) };
  }, cells);
  check('Repeated fast sweeps use cached geometry without layout reads', work.layoutReads === 0);
  check('Repeated fast sweeps still cover the full week', equal(await dates(), firstWeek));
  console.log('Calendar hover event cost:', JSON.stringify(work));

  await reset();
  cells = await rects();
  await page.mouse.move(cells[0].left - 3, cells[0].y);
  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerout', {bubbles:true,pointerType:'mouse',relatedTarget:null})));
  await page.mouse.move(cells[6].right + 3, cells[0].y);
  check('Returning from outside the browser does not bridge an unknown path', (await dates()).length === 0);

  await reset();
  cells = await rects();
  await page.mouse.move(cells[0].left - 3, cells[0].y);
  await page.locator('[data-calendar-view=quarter]').click();
  await settle();
  cells = await rects();
  const visible = cells.filter(cell => cell.top > 0 && cell.bottom < page.viewportSize().height - 30);
  const row = visible.filter(cell => cell.y === visible[0].y);
  await page.mouse.move(row[0].left - 3, row[0].y);
  await page.mouse.move(row.at(-1).right + 3, row[0].y);
  check('Quarter view uses its new date geometry after switching views', equal(await dates(), row.map(cell => cell.date).sort()));
  await page.locator('[data-calendar-view=year]').click();
  check('Switching to year view clears every date trail', (await dates()).length === 0);

  await page.locator('[data-month="5"]').click();
  const originalViewport = page.viewportSize();
  await page.setViewportSize({width:originalViewport.width,height:600});
  await settle();
  cells = await rects();
  await page.mouse.move(cells[0].left - 3, cells[0].y);
  await page.evaluate(() => {
    const dialog = document.getElementById('calendar-dialog');
    dialog.scrollTop = 80;
  });
  await settle();
  check('Scroll regression runs with an actually scrolled dialog', await page.locator('#calendar-dialog').evaluate(dialog => dialog.scrollTop > 0));
  cells = await rects();
  await page.mouse.move(cells[6].right + 3, cells[0].y);
  check('Scrolling discards the old pointer path before using shifted geometry', (await dates()).length === 0);
  await page.mouse.move(cells[0].left - 3, cells[0].y);
  check('A sparse sweep still works after scrolling', equal(await dates(), firstWeek));
  await page.setViewportSize(originalViewport);
  await page.locator('#calendar-dialog').evaluate(dialog => dialog.scrollTop = 0);
  await settle();

  await page.emulateMedia({reducedMotion:'reduce'});
  await reset();
  cells = await rects();
  await page.mouse.move(cells[0].left - 3, cells[0].y);
  await page.mouse.move(cells[6].right + 3, cells[0].y);
  check('Reduced motion does not reconstruct or retain a passing trail', (await dates()).length === 0);
  await page.mouse.move(cells[3].x, cells[3].y);
  check('Reduced motion still highlights the actual date under the pointer', equal(await dates(), ['2026-06-04']));
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.mouse.move(cells[3].x + 1, cells[3].y);
  check('Changing motion preference restores actual hover on the next in-cell move', equal(await dates(), ['2026-06-04']));
  await page.mouse.move(cells[6].right + 3, cells[0].y);
  check('Reduced motion clears the actual hover immediately on exit', (await dates()).length === 0);
  await page.emulateMedia({reducedMotion:'no-preference'});

  await reset();
  cells = await rects();
  const touchResult = await page.evaluate(cells => {
    for (const x of [cells[0].left - 3, cells[6].right + 3]) {
      document.getElementById('cal-stage').dispatchEvent(new PointerEvent('pointermove', {
        bubbles:true,pointerType:'touch',pointerId:9,clientX:x,clientY:cells[0].y
      }));
    }
    return document.querySelectorAll('.cal-day.is-hovered').length;
  }, cells);
  check('Touch gestures do not create date hover trails', touchResult === 0);
  await page.locator('#cal-today').click();
  await settle();
};
