const { spawn } = require('child_process');
const path = require('path');

console.log('[Dev] Starting Vite dev server...');

// Start Vite dev server
const vite = spawn(process.execPath, [path.join(__dirname, 'node_modules', 'vite', 'bin', 'vite.js')], {
  cwd: __dirname,
  stdio: 'pipe',
  env: { ...process.env }
});

let electronStarted = false;
let devUrl = 'http://localhost:5173';

function launchElectron() {
  if (electronStarted) return;
  electronStarted = true;

  console.log('\n[Dev] Launching Electron at', devUrl, '\n');

  const electronExe = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
  const electron = spawn(electronExe, ['.'], {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development', CASRION_DEV_URL: devUrl }
  });

  electron.on('error', (err) => {
    console.error('[Dev] Failed to start Electron:', err.message);
    vite.kill();
    process.exit(1);
  });

  electron.on('close', (code) => {
    console.log('[Dev] Electron closed with code:', code);
    vite.kill();
    process.exit(code || 0);
  });
}

vite.stdout.on('data', (data) => {
  const output = data.toString();
  process.stdout.write(output);

  // Capture the URL Vite actually bound to — it moves to 5174+ when 5173 is
  // taken, and Electron must follow it or the window loads a blank page.
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  const urlMatch = plain.match(/(https?:\/\/localhost:\d+)/);
  if (urlMatch) devUrl = urlMatch[1];

  // Check if Vite is ready (look for the ready message)
  if (plain.includes('ready in') || urlMatch) {
    // Small delay to ensure the server is fully listening
    setTimeout(launchElectron, 1000);
  }
});

vite.stderr.on('data', (data) => {
  process.stderr.write(data.toString());
});

vite.on('error', (err) => {
  console.error('[Dev] Failed to start Vite:', err.message);
  process.exit(1);
});

vite.on('close', (code) => {
  if (!electronStarted) {
    console.log('[Dev] Vite closed unexpectedly with code:', code);
    process.exit(code || 1);
  }
});

// Fallback: if nothing is detected within 10 seconds, launch anyway
setTimeout(() => {
  if (!electronStarted) {
    console.log('[Dev] Timeout reached, launching Electron anyway...');
    launchElectron();
  }
}, 10000);

// Handle Ctrl+C
process.on('SIGINT', () => {
  vite.kill();
  process.exit();
});

process.on('SIGTERM', () => {
  vite.kill();
  process.exit();
});
