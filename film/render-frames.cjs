// Capture every frame of a film page: node render-frames.cjs film-hero.html out-dir [fromSec toSec]
// Needs Node + Playwright (npm i playwright; npx playwright install chromium). Then:
// ffmpeg -framerate 30 -i out-dir/f%05d.jpg -c:v libx264 -crf 16 -pix_fmt yuv420p hero/render/film.video.mp4
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
(async () => {
  const [page, out, from, to] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  await p.goto('file://' + path.resolve(page) + '?render'); await p.waitForFunction(() => window.FILM && window.seek); await p.evaluate(() => document.fonts.ready);
  const { fps, duration } = await p.evaluate(() => ({ fps: window.FILM.fps || 30, duration: window.FILM.dur || window.FILM.duration }));
  const a = Math.round((+from || 0) * fps), z = Math.round((to !== undefined ? +to : duration) * fps);
  for (let i = a; i < z; i++) {
    await p.evaluate((t) => window.seek(t), i / fps);
    await p.screenshot({ path: path.join(out, `f${String(i - a).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 });
  }
  await b.close(); console.log(`${z - a} frames -> ${out}`);
})();
