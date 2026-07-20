// Polish layer: wraps a flat @2x master capture in an Apple-esque frame by
// screenshotting a CSS wrapper page (frame.html), and derives per-target sizes
// with the macOS image tool (sips). Two framing treatments:
//   - hero:    browser/window chrome (traffic lights + title bar) on a neutral
//              theme-aware gradient, for the three hero placements only.
//   - feature: a self-framed variant (rounded corners + soft shadow + small
//              neutral padding), for plain-markdown placements (README, raw
//              docs). Feature "flat" masters get no frame at all and are copied
//              or resized straight from the capture, for destinations that add
//              their own CSS frame.
//
// No image library is used for the frame itself: the premium look is pure CSS.
// sips (a system tool on macOS) does resize and format conversion, keeping the
// dependency footprint lean.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEVICE_SCALE } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FRAME_HTML_URL = pathToFileURL(path.join(__dirname, 'frame.html')).href;

// Reads a PNG's pixel dimensions straight from the IHDR chunk (bytes 16-24),
// so framing knows the master size without decoding the whole image.
export function pngDims(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(24);
  fs.readSync(fd, buf, 0, 24, 0);
  fs.closeSync(fd);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Frames a master into outPath using the given treatment and theme. The page
// must already be on FRAME_HTML_URL in a deviceScaleFactor:2 context, so the
// element screenshot lands at @2x.
export async function frameImage(page, { masterPath, outPath, theme, treatment, title = 'Rundock' }) {
  const { width } = pngDims(masterPath);
  const shotWCss = Math.round(width / DEVICE_SCALE);
  const pad = Math.round(shotWCss * (treatment === 'hero' ? 0.085 : 0.032));
  const dataUri = 'data:image/png;base64,' + fs.readFileSync(masterPath).toString('base64');

  await page.evaluate(async ({ theme, treatment, shotWCss, pad, title, dataUri }) => {
    document.body.className = `theme-${theme} treatment-${treatment}`;
    const root = document.documentElement.style;
    root.setProperty('--shot-w', shotWCss + 'px');
    root.setProperty('--pad', pad + 'px');
    root.setProperty('--radius', '12px');
    document.getElementById('title').textContent = title;
    const img = document.getElementById('shot');
    await new Promise((res) => { img.onload = res; img.onerror = res; img.src = dataUri; });
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch { /* ignore */ } }
  }, { theme, treatment, shotWCss, pad, title, dataUri });

  await page.waitForTimeout(60);
  const stage = await page.$('#stage');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await stage.screenshot({ path: outPath });
  return outPath;
}

// Resizes a PNG to a target width (keeping aspect), writing a new file. Never
// upscales: if the source is already narrower, it is copied unchanged.
export function resizeTo(srcPath, outPath, targetWidth) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const { width } = pngDims(srcPath);
  if (targetWidth >= width) { fs.copyFileSync(srcPath, outPath); return { resized: false, width }; }
  execFileSync('sips', ['--resampleWidth', String(targetWidth), srcPath, '--out', outPath], { stdio: 'ignore' });
  return { resized: true, width: targetWidth };
}

// Converts a PNG to WebP via sips where supported. Returns the out path on
// success, or null if this macOS build's sips cannot write WebP.
export function toWebp(srcPath, outPath) {
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    execFileSync('sips', ['-s', 'format', 'webp', srcPath, '--out', outPath], { stdio: 'ignore' });
    return fs.existsSync(outPath) ? outPath : null;
  } catch { return null; }
}
