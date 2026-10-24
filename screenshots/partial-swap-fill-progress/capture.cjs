const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:390,height:820},deviceScaleFactor:2});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:5188/screenshots/partial-swap-fill-progress/index.html');
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:'screenshots/partial-swap-fill-progress/activity-mobile-light.png',fullPage:true});
  await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await page.screenshot({path:'screenshots/partial-swap-fill-progress/activity-mobile-dark.png',fullPage:true});
  await page.setViewportSize({width:900,height:820});
  await page.evaluate(()=>document.documentElement.classList.remove('dark'));
  await page.screenshot({path:'screenshots/partial-swap-fill-progress/activity-desktop-light.png',fullPage:true});
  console.log(JSON.stringify({pageErrors:errors,percentages:await page.locator('[data-testid="activity-row-subtitle"]').allTextContents()}));
  await browser.close();
})();
