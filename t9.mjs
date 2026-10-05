import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(()=>chromium.launch());
const c = await b.newContext({ viewport:{width:844,height:390}, deviceScaleFactor:2, hasTouch:true });
const p = await c.newPage();
p.on('pageerror', e => console.log('ERR', e.message));
await p.goto('http://localhost:8765/'); await p.waitForTimeout(1500);
const put = async (tool, x, v, twice) => {
  await p.click(`[data-group=${tool}]`); await p.mouse.click(x,195); await p.waitForTimeout(100);
  if (twice) { await p.mouse.click(x,195); await p.waitForTimeout(200); }
  await p.fill('#pointValue', v); await p.click('[data-pact=ok]'); await p.waitForTimeout(200);
};
await put('scroll', 300, '1.5', true);
await put('scroll', 340, '2', true);
await put('bpm', 340, '180');
await put('scroll', 600, '0.8', true);
await put('measure', 500, '3/4');
await p.screenshot({ path: 'ev1.png' });
await p.mouse.click(320, 255); await p.waitForTimeout(400);
await p.screenshot({ path: 'ev2.png' });
await b.close();
