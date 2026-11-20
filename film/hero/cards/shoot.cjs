const { chromium } = require('playwright');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  for (const [m, n] of [['title', 78], ['end', 75]]) { require('fs').mkdirSync(`${__dirname}/${m}`, { recursive: true });
    await p.goto(`file://${__dirname}/card.html?m=${m}`); await p.waitForTimeout(500);
    for (let i = 0; i < n; i++) { await p.evaluate((t) => seek(t), i / 30); await p.screenshot({ path: `${__dirname}/${m}/f${String(i).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 92 }); } }
  await b.close(); })();
