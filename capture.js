const puppeteer  = require('puppeteer-core');
const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const { execFileSync } = require('child_process');

const CHROME     = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FFMPEG     = 'D:\\Download\\ffmpeg-8.0.1-essentials_build\\ffmpeg-8.0.1-essentials_build\\bin\\ffmpeg.exe';
const PORT       = 3334;
const FPS        = 12;
const WIDTH      = 420;
const HEIGHT     = 640;
const FRAMES_DIR = path.join(__dirname, '_frames');
const OUT_GIF    = path.join(__dirname, 'character.gif');

// anim0: 23.125s - 1.5s start = 21.625s
// anim1: 10.75s  - 1.0s start =  9.75s
const TOTAL_DURATION = 21.625 + 9.75; // ~31.375s
const TOTAL_FRAMES   = Math.ceil(TOTAL_DURATION * FPS); // ~376
const DELTA          = 1 / FPS;

// Simple static file server
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css': 'text/css', '.glb': 'model/gltf-binary',
};
function startServer() {
  const server = http.createServer((req, res) => {
    let url = req.url.split('?')[0];
    let filePath = path.join(__dirname, url === '/' ? 'capture.html' : url);
    const ext = path.extname(filePath);
    if (!fs.existsSync(filePath)) { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  server.listen(PORT);
  return server;
}

(async () => {
  // Prep frames dir
  if (fs.existsSync(FRAMES_DIR))
    fs.readdirSync(FRAMES_DIR).forEach(f => fs.unlinkSync(path.join(FRAMES_DIR, f)));
  else
    fs.mkdirSync(FRAMES_DIR);

  const server = startServer();
  console.log(`Server: http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--use-gl=angle',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });

  console.log('Loading page…');
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0', timeout: 60000 });

  // Wait for model to be ready
  await page.waitForFunction(() => window._ready === true, { timeout: 60000, polling: 500 });
  console.log('Model ready. Starting capture…');

  // Render first frame to flush any init cost
  await page.evaluate(() => window.stepFrame(0));
  await new Promise(r => setTimeout(r, 100));

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    await page.evaluate((d) => window.stepFrame(d), DELTA);
    const framePath = path.join(FRAMES_DIR, `f${String(i).padStart(5, '0')}.png`);
    await page.screenshot({ path: framePath, omitBackground: true, type: 'png' });
    if (i % FPS === 0) process.stdout.write(`\r  frame ${i}/${TOTAL_FRAMES} (${Math.round(i/TOTAL_FRAMES*100)}%)`);
  }
  console.log(`\nCapture complete: ${TOTAL_FRAMES} frames.`);

  await browser.close();
  server.close();

  // Build GIF with optimized palette
  console.log('Creating GIF…');
  execFileSync(FFMPEG, [
    '-y',
    '-framerate', String(FPS),
    '-i', path.join(FRAMES_DIR, 'f%05d.png'),
    '-vf', [
      `fps=${FPS}`,
      `scale=${WIDTH}:-1:flags=lanczos`,
      'split[s0][s1]',
      '[s0]palettegen=max_colors=255:reserve_transparent=on:transparency_color=000000[p]',
      '[s1][p]paletteuse=alpha_threshold=128:dither=bayer:bayer_scale=3',
    ].join(','),
    '-loop', '0',
    OUT_GIF,
  ], { stdio: 'inherit' });

  const sizeMB = (fs.statSync(OUT_GIF).size / 1024 / 1024).toFixed(2);
  console.log(`\nDone! character.gif → ${sizeMB} MB`);

  // Cleanup frames
  fs.readdirSync(FRAMES_DIR).forEach(f => fs.unlinkSync(path.join(FRAMES_DIR, f)));
  fs.rmdirSync(FRAMES_DIR);
})().catch(err => { console.error(err); process.exit(1); });
