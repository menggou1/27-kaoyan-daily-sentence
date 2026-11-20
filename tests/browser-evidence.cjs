const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function sessionWithEvidence(browser, name, options, run) {
  const context = await browser.newContext(options);
  const directory = process.env.TEST_ARTIFACTS;
  const requests = [];
  if (directory) {
    await context.tracing.start({screenshots:true, snapshots:true});
    context.on('request', request => requests.push({at:Date.now(), event:'request', url:request.url()}));
    context.on('response', response => requests.push({at:Date.now(), event:'response', url:response.url(), status:response.status()}));
    context.on('requestfailed', request => requests.push({at:Date.now(), event:'failed', url:request.url(), error:request.failure()?.errorText}));
  }
  try {
    await run(context);
    if (directory) await context.tracing.stop();
  } catch (error) {
    if (directory) {
      await fs.mkdir(directory, {recursive:true});
      const captures = await Promise.allSettled([
        context.tracing.stop({path:path.join(directory, `${name}-trace.zip`)}),
        fs.writeFile(path.join(directory, `${name}-requests.json`), JSON.stringify(requests, null, 2)),
        ...context.pages().map((page, index) => page.screenshot({path:path.join(directory, `${name}-${index}.png`), timeout:5000}))
      ]);
      for (const capture of captures) if (capture.status === 'rejected') console.error(capture.reason);
    }
    throw error;
  } finally {
    await context.close();
  }
};
