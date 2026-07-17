// Stages electron/ into electron-obf/ with all .cjs sources obfuscated.
// electron-builder packages electron-obf/ under the app's electron/ path,
// so shipped builds carry no readable main-process source. Dev runs keep
// using electron/ directly and are unaffected.
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'electron');
const outDir = path.join(root, 'electron-obf');

const OBF_OPTIONS = {
  target: 'node',
  compact: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: true,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.9,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: true,
  splitStringsChunkLength: 12,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  disableConsoleOutput: false,
};

fs.rmSync(outDir, { recursive: true, force: true });

function stage(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) stage(path.join(src, name), path.join(dst, name));
    return;
  }
  if (src.endsWith('.cjs')) {
    const code = fs.readFileSync(src, 'utf-8');
    const result = JavaScriptObfuscator.obfuscate(code, OBF_OPTIONS).getObfuscatedCode();
    fs.writeFileSync(dst, result);
    console.log(`obfuscated ${path.relative(root, src)} (${code.length} -> ${result.length} bytes)`);
  } else {
    fs.copyFileSync(src, dst);
  }
}

stage(srcDir, outDir);
console.log('electron-obf staged.');
