const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const SRC = __dirname;
const DIST = path.join(__dirname, '..', 'sardarji-dist');

const jsFiles = ['background.js', 'content.js', 'popup.js', 'sidebar.js', 'options.js', 'offscreen.js'];
const copyFiles = ['manifest.json', 'popup.html', 'popup.css', 'sidebar.html', 'sidebar.css', 'options.html', 'offscreen.html'];
const copyDirs = ['icons'];

async function build() {
  // Clean and create dist
  if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });

  // Obfuscate JS files
  for (const file of jsFiles) {
    const src = path.join(SRC, file);
    if (!fs.existsSync(src)) { console.log('Skip (missing): ' + file); continue; }
    const code = fs.readFileSync(src, 'utf8');
    try {
      const result = await minify(code, {
        compress: { dead_code: true, drop_console: false, passes: 2 },
        mangle: { toplevel: true, reserved: ['chrome'] },
        format: { comments: false }
      });
      fs.writeFileSync(path.join(DIST, file), result.code);
      console.log('Obfuscated: ' + file + ' (' + code.length + ' -> ' + result.code.length + ')');
    } catch (e) {
      console.error('Error in ' + file + ': ' + e.message);
      fs.writeFileSync(path.join(DIST, file), code);
    }
  }

  // Copy non-JS files
  for (const file of copyFiles) {
    const src = path.join(SRC, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(DIST, file));
      console.log('Copied: ' + file);
    }
  }

  // Copy directories
  for (const dir of copyDirs) {
    const srcDir = path.join(SRC, dir);
    const dstDir = path.join(DIST, dir);
    if (fs.existsSync(srcDir)) {
      fs.mkdirSync(dstDir, { recursive: true });
      for (const f of fs.readdirSync(srcDir)) {
        fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
      }
      console.log('Copied dir: ' + dir);
    }
  }

  console.log('\nBuild complete! Output: ' + DIST);
}

build().catch(console.error);
