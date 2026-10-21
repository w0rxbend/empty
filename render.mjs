// Renders the black hole in headless Chromium (software WebGL) and saves a PNG.
//   node render.mjs [--width 3840] [--height 2160] [--samples 3] [--out blackhole.png] [--key value ...]
// Any other --key value pair is passed straight to renderBlackHole() (see src/blackhole.js defaults).
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { startServer } from './scripts/serve.mjs';

const args = process.argv.slice(2);
const options = {};
let out = 'blackhole.png';
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace(/^--/, '');
  if (key === 'out') out = args[i + 1];
  else options[key] = Number(args[i + 1]);
}

const { server, port } = await startServer(0);
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('console', (m) => console.log(`[page] ${m.text()}`));
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.goto(`http://localhost:${port}/index.html?manual`);

  const started = Date.now();
  const dataUrl = await page.evaluate(async (opts) => {
    let last = '';
    return await window.renderBlackHole({
      ...opts,
      onProgress: (p, stage) => {
        const line = `${stage} ${Math.round(p * 100)}%`;
        if (line !== last && Math.round(p * 100) % 10 === 0) console.log(line);
        last = line;
      },
    });
  }, options);

  await writeFile(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`saved ${out} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} finally {
  await browser.close();
  server.close();
}
