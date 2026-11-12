// Independent wall/monotonic clocks reproduce hours of sleep without real waits.
module.exports = async function clockRecoveryChecks(browser, url, check) {
  const context = await browser.newContext({ timezoneId:'UTC', reducedMotion:'reduce' });
  await context.addInitScript(() => {
    const wallNow = Date.now.bind(Date);
    const tickNow = performance.now.bind(performance);
    const realFetch = window.fetch.bind(window);
    const state = window.clockTest = {
      wall:0, tick:0, server:Date.parse('2026-10-08T23:00:00+08:00'),
      requests:0, mode:'ok', pending:[]
    };
    Date.now = () => wallNow() + state.wall;
    performance.now = () => tickNow() + state.tick;
    window.fetch = (input, options) => {
      if (input !== 'https://utctime.app/api/now') return realFetch(input, options);
      state.requests++;
      const response = () => new Response(JSON.stringify({unix_ms:state.server}));
      if (state.mode === 'fail') return Promise.reject(new TypeError('Offline'));
      // Deliberately ignore abort: even a late old response must not win.
      if (state.mode === 'hold') return new Promise(resolve => state.pending.push(resolve));
      return Promise.resolve(response());
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById('clock-status').textContent.includes('已网络校时'));
    for (const event of ['visibilitychange', 'focus', 'resume', 'pageshow', 'online']) {
      const result = await page.evaluate(event => {
        const before = window.KaoyanExtras.now();
        const requests = clockTest.requests;
        clockTest.wall += 2 * 3600000;
        clockTest.server += 2 * 3600000;
        if (event === 'visibilitychange') {
          Object.defineProperty(document, 'hidden', { configurable:true, get:() => false });
        }
        (['visibilitychange', 'resume'].includes(event) ? document : window).dispatchEvent(new Event(event));
        return { elapsed:window.KaoyanExtras.now() - before, requests:clockTest.requests - requests };
      }, event);
      check(`Sleep recovery immediately catches up on ${event}`, Math.abs(result.elapsed - 7200000) < 1000);
      check(`Recovery forces network sync before ten-minute limit on ${event}`, result.requests === 1);
      await page.waitForFunction(() => Math.abs(window.KaoyanExtras.now() - clockTest.server) < 1000);
    }
    check('Wake across Beijing midnight refreshes date', await page.locator('#date').textContent() === '10-09');
    await page.waitForFunction(() => document.getElementById('sentence').textContent.includes('只要比昨天的自己多懂一点点'));
    check('Wake across midnight refreshes daily quote', (await page.locator('#sentence').textContent()).includes('只要比昨天的自己多懂一点点'));
    await page.locator('#card-flip').click();
    const dailyIsCurrent = () => {
      const seconds = document.getElementById('midnight-countdown').textContent.split(':').reduce((total, part) => total * 60 + Number(part), 0);
      return Math.abs(seconds - 15 * 3600) < 5;
    };
    await page.waitForFunction(dailyIsCurrent);
    check('Daily clock shares recovered time', await page.evaluate(dailyIsCurrent));
    await page.locator('#card-unflip').click();

    const offline = await page.evaluate(() => {
      clockTest.mode = 'fail';
      const before = window.KaoyanExtras.now();
      clockTest.wall += 7200000;
      clockTest.server += 7200000;
      document.dispatchEvent(new Event('resume'));
      return window.KaoyanExtras.now() - before;
    });
    check('Offline wake retains network offset and catches up without refresh', Math.abs(offline - 7200000) < 1000);
    await page.waitForFunction(() => document.getElementById('clock-status').textContent.includes('保持中'));

    const gap = await page.evaluate(() => {
      const before = window.KaoyanExtras.now();
      clockTest.wall += 7200000;
      clockTest.tick += 6000;
      clockTest.server += 7200000;
      return window.KaoyanExtras.now() - before;
    });
    check('Long timer gap repairs stalled monotonic time without lifecycle events', Math.abs(gap - 7200000) < 1000);
    const tickingSleep = await page.evaluate(() => {
      const before = window.KaoyanExtras.now();
      clockTest.wall += 7200000;
      clockTest.tick += 7200000;
      clockTest.server += 7200000;
      return window.KaoyanExtras.now() - before;
    });
    check('Sleep with advancing monotonic time is not counted twice', Math.abs(tickingSleep - 7200000) < 1000);
    for (const change of [3600000, -7200000]) {
      const elapsed = await page.evaluate(change => {
        const before = window.KaoyanExtras.now();
        clockTest.wall += change;
        return window.KaoyanExtras.now() - before;
      }, change);
      check(`Active device clock adjustment ${change}ms keeps network time stable`, Math.abs(elapsed) < 1000);
    }
    await page.evaluate(() => { clockTest.mode = 'ok'; window.dispatchEvent(new Event('online')); });
    await page.waitForFunction(() => document.getElementById('clock-status').textContent.includes('已网络校时'));
    check('Reconnecting restores verified network time', await page.evaluate(() => Math.abs(window.KaoyanExtras.now() - clockTest.server) < 1000));

    await page.evaluate(() => {
      clockTest.wall += 7200000;
      clockTest.server += 7200000;
    });
    await page.waitForFunction(() => Math.abs(window.KaoyanExtras.now() - clockTest.server) < 1000);
    check('Watchdog resyncs a stalled clock even without a lifecycle event', await page.evaluate(() => Math.abs(window.KaoyanExtras.now() - clockTest.server) < 1000));

    await page.evaluate(() => { clockTest.mode = 'hold'; window.dispatchEvent(new Event('focus')); });
    await page.waitForFunction(() => clockTest.pending.length === 1);
    const replaced = await page.evaluate(() => {
      const requests = clockTest.requests;
      clockTest.wall += 7200000;
      clockTest.server += 7200000;
      clockTest.mode = 'ok';
      document.dispatchEvent(new Event('resume'));
      return clockTest.requests - requests;
    });
    check('Wake replaces request whose timeout was suspended', replaced === 1);
    await page.waitForFunction(() => Math.abs(window.KaoyanExtras.now() - clockTest.server) < 1000);
    await page.evaluate(() => clockTest.pending.shift()(new Response(JSON.stringify({unix_ms:Date.parse('2026-01-01T00:00:00Z')}))));
    await page.waitForTimeout(50);
    check('Late pre-sleep response cannot overwrite recovered time', await page.evaluate(() => Math.abs(window.KaoyanExtras.now() - clockTest.server) < 1000));

    check('Clock recovery produces no runtime errors', errors.length === 0);
  } finally {
    await context.close();
  }
};
