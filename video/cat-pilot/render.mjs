// Renders scene.html frame by frame and encodes cat-pilot.mp4 (720x1280, 30 fps).
// Usage: node render.mjs [seconds]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const globalRoot = execFileSync('npm', ['root', '-g']).toString().trim();
const { chromium } = require(path.join(globalRoot, 'playwright'));

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SECONDS = Number(process.argv[2] || 2);
const FPS = 30;
const FRAMES_DIR = path.join(DIR, 'frames');
const OUT = path.join(DIR, 'cat-pilot.mp4');

fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
fs.mkdirSync(FRAMES_DIR);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 576, height: 1024 }, deviceScaleFactor: 1.25 });
await page.goto(pathToFileURL(path.join(DIR, 'scene.html')).href);

const total = Math.round(SECONDS * FPS);
for (let i = 0; i < total; i++) {
  await page.evaluate(t => window.render(t), i / FPS);
  await page.screenshot({ path: path.join(FRAMES_DIR, `f${String(i).padStart(4, '0')}.png`) });
}
await browser.close();

// Picture plus a synthetic storm bed: low rumble with a thunder swell at the flash (~0.9 s).
execFileSync('ffmpeg', [
  '-y', '-v', 'error',
  '-framerate', String(FPS), '-i', path.join(FRAMES_DIR, 'f%04d.png'),
  '-f', 'lavfi', '-t', String(SECONDS), '-i', 'anoisesrc=color=brown:amplitude=0.6:seed=3',
  '-filter_complex',
  `[1:a]lowpass=f=300,volume='0.35+1.6*between(t,0.88,1.6)*exp(-(t-0.88)*2.5)':eval=frame,afade=t=out:st=${SECONDS - 0.3}:d=0.3[a]`,
  '-map', '0:v', '-map', '[a]',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
  '-c:a', 'aac', '-b:a', '128k', '-shortest', OUT,
]);
fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
console.log(`wrote ${OUT} (${total} frames)`);
