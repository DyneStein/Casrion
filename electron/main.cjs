const { app, BrowserWindow, globalShortcut, clipboard, Tray, Menu, ipcMain, nativeImage, dialog, protocol, shell, systemPreferences } = require('electron');

// The capture shortcuts are Ctrl-based on Windows and Cmd-based on macOS;
// user-facing strings pick the right word.
const MOD_LABEL = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
// How each OS puts a screenshot on the clipboard (macOS defaults to saving a
// file; adding Ctrl copies it instead), shown when the clipboard has no image.
const SCREENSHOT_HINT = process.platform === 'darwin'
  ? 'Take a screenshot to the clipboard first (Ctrl+Cmd+Shift+4)'
  : 'Take a screenshot first (Win+Shift+S)';
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const { normalizeCapture, stripColorMarkup } = require('./capture-normalize.cjs');
const { patchWebmDuration } = require('./webm-duration.cjs');
const explainFeature = require('./explain.cjs');

// Build integrity tag — do not remove.
const APP_MARK = 'Q2FzcmlvbiDigJQgb3JpZ2luYWwgd29yayBvZiBEeWVuIMK3IG1keWVuYXNpZkBnbWFpbC5jb20gwrcgZXN0LiAyMDI2';

protocol.registerSchemesAsPrivileged([
  { scheme: 'casrion', privileges: { secure: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true, stream: true } }
]);

let mainWindow;
let boardWindow;
let overlayWindow;
let helpOverlayWindow;
let quickInputWindow;
let tray;

// ─── Application State ───────────────────────────────────────
let activeFilePath = null;
let insertionLine = -1; // -1 means end of file
let settings = {};
let undoStack = []; // stores { filePath, content, insertionLine } snapshots
let redoStack = []; // undone snapshots, cleared by any fresh change
let isRecording = false;
// The recorder itself lives in the renderer, so "recording" is only real once
// that side says so. Until then the sticky "Recording..." toast is a promise
// we have not kept, and a microphone that never opens must not leave it up.
let recordingConfirmed = false;
let recordingStartTimer = null;
const RECORDING_START_TIMEOUT = 8000;
const MAX_UNDO = 50;

const settingsPath = path.join(app.getPath('userData'), 'casrion-settings.json');

// ─── Undo History ──────────────────────────────────────────

// Snapshots are whole-file copies, so very large notes could pin a lot of
// memory across 50 entries — bound the total bytes too, oldest dropped first.
const MAX_UNDO_BYTES = 10 * 1024 * 1024;

function capSnapshotStack(stack) {
  if (stack.length > MAX_UNDO) stack.shift();
  let bytes = stack.reduce((n, s) => n + s.content.length, 0);
  while (bytes > MAX_UNDO_BYTES && stack.length > 1) {
    bytes -= stack.shift().content.length;
  }
}

function pushUndo() {
  if (!activeFilePath) return;
  const content = readFileContent(activeFilePath);
  undoStack.push({ filePath: activeFilePath, content, insertionLine });
  capSnapshotStack(undoStack);
  // A fresh change forks history; the undone branch can no longer be redone
  redoStack = [];
}

function performUndo() {
  if (!activeFilePath) {
    showOverlayNotification('No file selected!', 'error');
    return;
  }
  // Snapshots are tagged with the file they came from; only undo changes
  // that belong to the currently active file so we never write one note's
  // content into another.
  const top = undoStack[undoStack.length - 1];
  if (!top || top.filePath !== activeFilePath) {
    showOverlayNotification('Nothing to undo for this note', 'error');
    return;
  }
  undoStack.pop();
  // Remember what the note looked like right now, so redo can bring it back
  redoStack.push({ filePath: activeFilePath, content: readFileContent(activeFilePath), insertionLine });
  capSnapshotStack(redoStack);
  showOverlayNotification('Undo complete', 'text');
  writeFileAtomic(top.filePath, top.content, 'utf-8');
  insertionLine = top.insertionLine;
  // The undone capture may have carried a source stamp — forget the dedupe
  // state so the next capture stamps again instead of assuming one exists.
  lastStamp = { title: null, file: null };
  console.log('[Casrion] Undo performed, stack size:', undoStack.length);
  notifyRendererFileUpdated();
}

function performRedo() {
  if (!activeFilePath) {
    showOverlayNotification('No file selected!', 'error');
    return;
  }
  const top = redoStack[redoStack.length - 1];
  if (!top || top.filePath !== activeFilePath) {
    showOverlayNotification('Nothing to redo for this note', 'error');
    return;
  }
  redoStack.pop();
  // Push the pre-redo state manually: pushUndo() would wipe the redo branch
  undoStack.push({ filePath: activeFilePath, content: readFileContent(activeFilePath), insertionLine });
  capSnapshotStack(undoStack);
  showOverlayNotification('Redo complete', 'text');
  writeFileAtomic(top.filePath, top.content, 'utf-8');
  insertionLine = top.insertionLine;
  lastStamp = { title: null, file: null };
  console.log('[Casrion] Redo performed, stack size:', redoStack.length);
  notifyRendererFileUpdated();
}

// ─── Settings Persistence ─────────────────────────────────
/**
 * Write a file so that it is never observed half written.
 *
 * fs.writeFileSync truncates the target and then streams into it, so a crash,
 * a power cut or a battery dying anywhere in the middle leaves a note that is
 * cut in half, and the second half is gone. That is the one failure this app
 * must not have: the whole promise is that the notes are plain files that
 * outlive it. Writing beside the target and renaming over it makes the swap
 * atomic on both NTFS and APFS, so a reader sees either the old file or the
 * new one and never a torn one.
 *
 * The fallback matters on Windows: if something else holds the destination
 * open (an editor with the note open, antivirus mid-scan) the rename can fail
 * where a plain write would have worked, and refusing to save would be worse
 * than saving non-atomically. So try for atomic, settle for written.
 */
function writeFileAtomic(filePath, data, encoding) {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.casrion-tmp`);
  try {
    fs.writeFileSync(tmp, data, encoding);
    fs.renameSync(tmp, filePath);
    return;
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* leave the stray temp */ }
    console.warn('[Casrion] Atomic write fell back to a direct write:', e.message);
  }
  fs.writeFileSync(filePath, data, encoding);
}

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      // Strip a UTF-8 BOM if present (external editors/tools may add one)
      const raw = fs.readFileSync(settingsPath, 'utf-8').replace(/^﻿/, '');
      settings = JSON.parse(raw);
    }
  } catch (e) {
    console.error('[Casrion] Failed to load settings:', e.message);
    // Falling back to defaults is right, but the next saveSettings would then
    // write those defaults straight over the unreadable file and take the
    // user's folder list with it. Keep the wreckage: it is the only copy of
    // where their notes live, and it is usually recoverable by hand.
    try {
      const kept = settingsPath.replace(/\.json$/, '') + `.corrupt-${Date.now()}.json`;
      fs.renameSync(settingsPath, kept);
      console.error('[Casrion] Kept the unreadable settings file at', kept);
    } catch { /* it may not even exist any more */ }
    settings = {};
  }
  
  // Migrate old workingFolder string to array
  if (settings.workingFolder && !settings.workingFolders) {
    settings.workingFolders = [settings.workingFolder];
    delete settings.workingFolder;
  }
  if (!settings.workingFolders) {
    settings.workingFolders = [];
  }
  
  return settings;
}

function saveSettings() {
  try {
    writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('[Casrion] Failed to save settings:', e.message);
  }
}

// ─── File Operations ───────────────────────────────────────

function buildWorkspace() {
  if (!settings.workingFolders) settings.workingFolders = [];

  // Show only folders that exist right now, but do NOT delete missing ones
  // from settings — a folder on a USB/network drive must survive a temporary
  // disconnect and reappear when the drive comes back. Explicit removal
  // happens only through the remove-folder handler.
  const validFolders = settings.workingFolders.filter(folder => {
    try { return fs.existsSync(folder); } catch { return false; }
  });

  return validFolders.map(folder => {
    return {
      folderPath: folder,
      folderName: folder.split(/[/\\]/).pop(),
      files: listMdFiles(folder)
    };
  });
}
function listMdFiles(folderPath) {
  try {
    if (!folderPath || !fs.existsSync(folderPath)) return [];
    // No stat per file on purpose. This runs inside buildStatePayload, which
    // every capture and eight other IPC handlers rebuild from scratch, so a
    // syscall per note was a syscall per note per capture: about 12ms of a
    // 200 note folder, on the main thread, every time anything was kept.
    // It used to carry size and modified, and nothing has ever read either.
    // withFileTypes gets the entry kind out of the directory scan already in
    // flight, so it also stops a directory called "foo.md" listing as a note.
    return fs.readdirSync(folderPath, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.md'))
      .map(d => ({
        name: d.name.replace(/\.md$/i, ''),
        filename: d.name,
        path: path.join(folderPath, d.name)
      }))
      // Stable alphabetical order — mtime sorting made the list reshuffle on every capture
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  } catch (e) {
    console.error('[Casrion] Failed to list files:', e.message);
    return [];
  }
}

function readFileContent(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      let content = fs.readFileSync(filePath, 'utf-8');

      // Normalize CRLF so line-based insertion math is consistent
      // (files edited externally in Notepad etc. arrive with \r\n)
      content = content.replace(/\r\n?/g, '\n');

      // Auto-migrate legacy absolute paths to the new relative pathing system
      const originalContent = content;
      // Handle both Markdown format and HTML src format (for file:/// and
      // casrion://). The optional third slash also catches hydrated
      // "casrion://C:/..." URLs that an older editor build saved to disk.
      content = content.replace(/\]\((?:file|casrion):\/\/\/?[^)]+\/assets\/([^)]+)\)/g, '](assets/$1)');
      content = content.replace(/src="(?:file|casrion):\/\/\/?[^"]+\/assets\/([^"]+)"/g, 'src="assets/$1"');

      // Heal source stamps that an older editor build flattened into plain
      // text ("Source: title · [url](url) · 12:05 am" on its own line):
      // rewrap them so they become hidden metadata again instead of clutter.
      content = content.replace(/^Source:\s?(\S.*·\s*\d{1,2}:\d{2}\s?[ap]m)\s*$/gim, (line, body) => {
        let b = body.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1');   // unwrap markdown links
        b = b.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');       // undo turndown escapes
        b = b.replace(/&(?!(?:amp|lt|gt|quot|#\d+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<sub>Source: ${b.trim()}</sub>`;
      });

      // Heal list markers an older editor build escaped into plain text
      // ("\- item" lines): those came from lists that sat directly under a
      // stamp or memo line and got flattened by the markdown round trip.
      content = content.replace(/^\\(?=[-*] )/gm, '');

      // Heal LaTeX whose backslashes a capture build doubled ("\\frac"):
      // KaTeX reads "\\" as a line break, so a doubled command rendered as its
      // plain letters ("frac"). Only inside math spans, and only a doubled
      // backslash that begins a command word, so real "\\" line breaks (which
      // are followed by whitespace/braces/end) are left untouched.
      content = content.replace(
        /\$\$[\s\S]*?\$\$|\$[^$\n]+?\$/g,
        (span) => span.replace(/\\\\(?=[A-Za-z])/g, '\\')
      );

      if (content !== originalContent) {
        writeFileAtomic(filePath, content, 'utf-8');
        console.log(`[Casrion] Auto-migrated legacy paths in ${filePath}`);
      }
      
      return content;
    }
  } catch (e) {
    console.error('[Casrion] Failed to read file:', e.message);
  }
  return '';
}

function getLines() {
  if (!activeFilePath) return [];
  const content = readFileContent(activeFilePath);
  return content.split('\n');
}

// Append text to the END of an existing line (same paragraph continuation)
function appendToLine(text, lineNum) {
  if (!activeFilePath) return -1;
  const lines = getLines();

  // Split multiline text into an array of lines
  const textLines = text.split(/\r?\n/);
  const firstTextLine = textLines[0] || '';
  const restTextLines = textLines.slice(1);

  // Smart checking: if current line is a heading, list, blockquote, image,
  // source stamp, voice memo or other HTML block, auto-push to new line.
  // Stamps especially must stay alone on their line — text glued onto one
  // stops the viewer from hiding it.
  const smartRegex = /^(#{1,6}\s|[-*]\s|\d+\.\s|>\s?|!\[|<sub|<audio|<\/?div)/;

  if (lineNum >= 0 && lineNum < lines.length && smartRegex.test(lines[lineNum])) {
    // Current line is a structural block. Insert below it with one blank
    // separator: without it, markdown reads plain text under a list or
    // quote line as a lazy continuation and merges it into that block.
    lines.splice(lineNum + 1, 0, '', ...textLines);
    writeFileAtomic(activeFilePath, lines.join('\n'));
    return lineNum + 1 + textLines.length;
  }

  if (lineNum < 0 || lineNum >= lines.length) {
    // Append at end of file
    const currentLast = lines.length - 1;
    if (lines[currentLast] && lines[currentLast].trim() !== '') {
      // Last line has content, append to it (check if it's structural too)
      if (smartRegex.test(lines[currentLast])) {
        lines.push('', ...textLines);
        writeFileAtomic(activeFilePath, lines.join('\n'));
        return lines.length - 1;
      } else {
        lines[currentLast] = lines[currentLast] + ' ' + firstTextLine;
        if (restTextLines.length > 0) {
          lines.push(...restTextLines);
        }
        writeFileAtomic(activeFilePath, lines.join('\n'));
        return lines.length - 1;
      }
    } else {
      // Last line is empty, put text there
      lines.splice(currentLast, 1, ...textLines);
      writeFileAtomic(activeFilePath, lines.join('\n'));
      return currentLast + textLines.length - 1;
    }
  } else {
    // Append to the specified line
    if (lines[lineNum].trim() === '') {
      lines[lineNum] = firstTextLine;
    } else {
      lines[lineNum] = lines[lineNum] + ' ' + firstTextLine;
    }
    if (restTextLines.length > 0) {
      lines.splice(lineNum + 1, 0, ...restTextLines);
    }
    writeFileAtomic(activeFilePath, lines.join('\n'));
    return lineNum + restTextLines.length;
  }
}

// Insert a NEW line after the insertion point (for headings, images, new paragraphs).
// Blank-aware: reuses empty lines already at the target instead of stacking more,
// so repeated Ctrl+Shift+N presses or blank-line targets never inflate spacing.
function insertNewLineAfter(text, lineNum) {
  if (!activeFilePath) return -1;
  const lines = getLines();
  const textLines = text.split(/\r?\n/);

  if (lineNum < 0 || lineNum >= lines.length) {
    // Append at end. Collapse a run of trailing blank lines down to one
    // separator instead of adding another on top of them.
    while (lines.length > 1 && lines[lines.length - 1].trim() === '' && lines[lines.length - 2].trim() === '') {
      lines.pop();
    }
    if (lines.length === 1 && lines[0].trim() === '') {
      // Empty note: start writing from the top, no leading blank line
      lines.splice(0, 1, ...textLines);
    } else if (lines[lines.length - 1].trim() === '') {
      lines.push(...textLines);
    } else {
      lines.push('', ...textLines);
    }
    writeFileAtomic(activeFilePath, lines.join('\n'));
    return lines.length - 1;
  }

  if (lines[lineNum].trim() === '') {
    // The insertion point is already an empty line (e.g. right after
    // Ctrl+Shift+N): write into it, keeping one separator from text above.
    const sep = lineNum > 0 && lines[lineNum - 1].trim() !== '' ? [''] : [];
    lines.splice(lineNum, 1, ...sep, ...textLines);
    writeFileAtomic(activeFilePath, lines.join('\n'));
    return lineNum + sep.length + textLines.length - 1;
  }

  // Insert after the specified line with one separating blank line
  lines.splice(lineNum + 1, 0, '', ...textLines);
  writeFileAtomic(activeFilePath, lines.join('\n'));
  return lineNum + 1 + textLines.length; // the new line's index
}

// Insert a blank line (for Alt+N new paragraph)
function insertBlankLine(lineNum) {
  if (!activeFilePath) return -1;
  const lines = getLines();

  if (lineNum < 0 || lineNum >= lines.length) {
    lines.push('');
    writeFileAtomic(activeFilePath, lines.join('\n'));
    return lines.length - 1;
  } else {
    lines.splice(lineNum + 1, 0, '');
    writeFileAtomic(activeFilePath, lines.join('\n'));
    return lineNum + 1;
  }
}

// Single source of truth for everything the renderer needs to display.
// Content is ALWAYS hydrated here — returning raw relative asset paths was
// the reason screenshots disappeared after re-adding a moved folder.
function buildStatePayload() {
  const content = activeFilePath
    ? hydrateContentForRenderer(readFileContent(activeFilePath), activeFilePath)
    : '';
  return {
    workspace: buildWorkspace(),
    activeFilePath,
    filePath: activeFilePath,
    content,
    insertionLine,
    stampSource: !!settings.stampSource
  };
}

function notifyRendererFileUpdated() {
  if (mainWindow && !mainWindow.isDestroyed() && activeFilePath) {
    mainWindow.webContents.send('file-updated', buildStatePayload());
  }
}

function showOverlayNotification(message, type = 'text', duration = 2000) {
  // The toast window can die with a GPU/renderer crash — rebuild it on
  // demand so on-screen feedback never silently disappears for the session.
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
    overlayWindow.webContents.once('did-finish-load', () => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        if (!overlayWindow.isVisible()) overlayWindow.showInactive();
        overlayWindow.webContents.send('show-notification', { message, type, duration });
      }
    });
    return;
  }
  if (!overlayWindow.isVisible()) overlayWindow.showInactive();
  overlayWindow.webContents.send('show-notification', { message, type, duration });
}

// ─── Window & Tray ─────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 700,
    minHeight: 500,
    icon: process.platform === 'win32'
      ? path.join(__dirname, 'icons', 'app.ico')
      : path.join(__dirname, 'icons', 'icon_256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      // Full speed while visible; the hide/show handlers below re-enable
      // throttling whenever the window sits in the tray (except while the
      // recorder, which lives in this window, is running).
      backgroundThrottling: false
    },
    autoHideMenuBar: true,
    title: 'Casrion',
    backgroundColor: '#110e0d',
    // Desktop-app chrome: the renderer's slim header doubles as the title
    // bar (drag region in CSS). On Windows we draw our own minimize/maximize/
    // close controls (titleBarOverlay) over it; on macOS the native traffic
    // lights stay, vertically centered in the 40px header, and the renderer
    // pads its left edge (body.platform-mac) so nothing sits under them.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 13, y: 13 } }
      : { titleBarOverlay: { color: '#e6dbc5', symbolColor: '#5f5344', height: 40 } }),
    show: false
  });

  const isDev = process.env.NODE_ENV === 'development';
  console.log('[Casrion] NODE_ENV:', process.env.NODE_ENV, '| isDev:', isDev);

  if (isDev) {
    // dev.cjs passes the real Vite URL (the port shifts to 5174+ when 5173 is
    // already taken by a leftover instance, which used to leave this window
    // pointing at a dead port — a blank screen).
    const devUrl = process.env.CASRION_DEV_URL || 'http://localhost:5173';
    let devRetries = 0;
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDesc, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 /* ERR_ABORTED: normal during reloads */) return;
      if (devRetries++ < 60) {
        console.log(`[Casrion] Dev server not ready (${errorDesc}), retry ${devRetries}...`);
        setTimeout(() => {
          if (!mainWindow.isDestroyed()) mainWindow.loadURL(devUrl);
        }, 500);
      } else {
        console.error('[Casrion] Gave up waiting for dev server at', devUrl);
      }
    });
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Links inside notes must never navigate the app itself (that shows a
  // dead page until restart) and must never open child app windows. Send
  // web links to the user's default browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow.webContents.getURL()) return; // reloads are fine
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    console.log('[Casrion] Window shown');
  });

  mainWindow.on('close', (event) => {
    if (app.isQuiting) return;
    // macOS: hiding a frameless window here leaves a black, unresponsive
    // ghost window (a known compositor bug), so let the window close for
    // real. The app keeps running (menu-bar icon + the hidden helper
    // windows), and reopening rebuilds a fresh window that reloads state
    // from disk. Windows/Linux keep the hide-to-tray behavior.
    if (process.platform === 'darwin') {
      if (!settings.trayNoticeShown) {
        settings.trayNoticeShown = true;
        saveSettings();
        showOverlayNotification('Casrion is still running in the menu bar', 'text', 5000);
      }
      return; // do not preventDefault: allow the destroy
    }
    event.preventDefault();
    mainWindow.hide();
    // First time only: tell the user where the app went — the tray icon
    // often lands in the hidden overflow area and is easy to miss.
    if (!settings.trayNoticeShown) {
      settings.trayNoticeShown = true;
      saveSettings();
      showOverlayNotification('Casrion is minimized to the system tray', 'text', 5000);
    }
  });

  // On macOS the window is really destroyed on close; drop the reference so
  // the tray/dock handlers know to rebuild it on next open.
  mainWindow.on('closed', () => { mainWindow = null; });

  // Parked in the tray the renderer needs no frames or fast timers — let
  // Chromium throttle it to near-idle so a hidden Casrion costs as little
  // as possible. Hotkey captures are unaffected (they run in this process
  // and only send the renderer an update it applies on next wake). The one
  // exception is voice recording, which runs inside that renderer.
  mainWindow.on('hide', () => {
    if (!isRecording) mainWindow.webContents.setBackgroundThrottling(true);
  });
  mainWindow.on('show', () => {
    mainWindow.webContents.setBackgroundThrottling(false);
  });

  // A crashed renderer would otherwise leave a dead blank window (and a dead
  // recorder) for the rest of the session — reload it instead.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') {
      console.error('[Casrion] Renderer gone (' + details.reason + '), reloading');
      isRecording = false;
      recordingConfirmed = false;
      clearTimeout(recordingStartTimer);
      mainWindow.webContents.reload();
    }
  });
}

// Bring the main window forward from the tray/dock. On macOS the window may
// have been destroyed on close, so rebuild it; otherwise just restore, show
// and focus the existing one.
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createOverlayWindow() {
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  overlayWindow = new BrowserWindow({
    // Wide enough for full toast messages — the pill itself auto-sizes,
    // the rest of the window is invisible and click-through.
    width: 640,
    height: 100,
    x: Math.floor(width / 2 - 320), // Center horizontally
    y: height - 120, // Bottom placement
    transparent: true,
    // A fully transparent backing color stops macOS painting the frameless
    // window solid black before the web content's first paint.
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // Never throttle: the overlay is usually occluded by other windows,
      // and throttled rendering freezes the toast fade-in at opacity 0.
      backgroundThrottling: false
    }
  });

  // Make it fully click-through
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  floatOverEverything(overlayWindow);
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
}

// macOS treats a 'screen-saver'-level window as tied to the Space it opened
// on and hides it behind fullscreen apps, which looked like the overlay
// "opening on another window". Pinning it to all Spaces (including over
// fullscreen) makes it float above wherever the user actually is.
function floatOverEverything(win) {
  if (process.platform !== 'darwin') return;
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* older macOS */ }
}

function createHelpOverlay() {
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  helpOverlayWindow = new BrowserWindow({
    width: 480,
    height: 580,
    x: Math.floor(width / 2 - 240),
    y: Math.floor(height / 2 - 290),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // Static content, no timers or animations — fine to throttle while
      // it waits hidden, which keeps the idle footprint down.
      backgroundThrottling: true
    }
  });

  helpOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
  floatOverEverything(helpOverlayWindow);
  helpOverlayWindow.loadFile(path.join(__dirname, 'help-overlay.html'));

  // Clicking anywhere outside the overlay (another window, the desktop)
  // steals focus from it, and losing focus dismisses it.
  helpOverlayWindow.on('blur', () => {
    if (helpOverlayWindow && !helpOverlayWindow.isDestroyed() && helpOverlayWindow.isVisible()) {
      helpOverlayWindow.hide();
    }
  });
}

// Quick note popup: type into the active note from anywhere, without
// bringing up the main window. Pre-created hidden so it opens instantly.
function createQuickInputWindow() {
  quickInputWindow = new BrowserWindow({
    width: 600,
    height: 210,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });
  quickInputWindow.setAlwaysOnTop(true, 'screen-saver');
  floatOverEverything(quickInputWindow);
  quickInputWindow.loadFile(path.join(__dirname, 'quick-input.html'));

  // Clicking anywhere else cancels; the typed draft is kept for next time
  quickInputWindow.on('blur', () => {
    if (quickInputWindow && !quickInputWindow.isDestroyed() && quickInputWindow.isVisible()) {
      quickInputWindow.hide();
    }
  });
}

/**
 * The whiteboard floats over whatever you were doing, like the quick note
 * popup, rather than dragging the main window forward. It is created on first
 * use, not at launch, so a user who never draws never pays for the renderer.
 *
 * No blur-to-dismiss here, unlike the other overlays: losing an unsaved
 * drawing because you clicked the wrong thing would be unforgivable.
 */
function createBoardWindow() {
  boardWindow = new BrowserWindow({
    width: 1000,
    height: 660,
    frame: false,
    // Opaque on purpose, unlike the pill-shaped overlays: a transparent window
    // gives up compositing shortcuts, and this one repaints a full canvas on
    // every pointer move. Smooth strokes beat rounded corners.
    backgroundColor: '#241f1b',
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });
  boardWindow.setAlwaysOnTop(true, 'screen-saver');
  floatOverEverything(boardWindow);
  // A trackpad pinch is easy to trigger by accident with a hand resting on it,
  // and zooming the drawing surface mid-stroke would be baffling.
  boardWindow.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  // Windows and Linux hang the default menu off each window, and its
  // accelerators fire even though a frameless window shows no menu bar. The
  // board owns its own keys, so it gets no menu at all. (macOS keeps one menu
  // for the whole app, so it is handled per-focus below instead.)
  if (process.platform !== 'darwin') boardWindow.setMenu(null);
  boardWindow.loadFile(path.join(__dirname, 'board.html'));

  // Clicking away must not dismiss it (that would bin an unsaved drawing), but
  // it must not sit on top of everything either, with no taskbar entry to dig
  // it back out of. So it stops floating while you are elsewhere and floats
  // again the moment you come back to it.
  boardWindow.on('blur', () => {
    if (boardWindow && !boardWindow.isDestroyed()) boardWindow.setAlwaysOnTop(false);
    setBoardMenuKeysFree(false);
  });
  boardWindow.on('focus', () => {
    if (boardWindow && !boardWindow.isDestroyed()) boardWindow.setAlwaysOnTop(true, 'screen-saver');
    setBoardMenuKeysFree(true);
  });
  boardWindow.on('hide', () => setBoardMenuKeysFree(false));
  boardWindow.on('closed', () => setBoardMenuKeysFree(false));

  // Cmd+W, or anything else that asks the window to close, would take an
  // unsaved drawing with it. Hand the request to the board so it runs the same
  // "lose this drawing?" check the close button does. Quitting still wins.
  boardWindow.on('close', (e) => {
    if (quitting || !boardWindow || boardWindow.isDestroyed()) return;
    e.preventDefault();
    boardWindow.webContents.send('board-close-request');
  });
}

/**
 * macOS puts one menu bar at the top of the screen for the whole app, and its
 * key equivalents are matched before a keystroke ever reaches the page. That
 * means Electron's stock Edit menu quietly eats Cmd+Z and Cmd+Shift+Z, so the
 * board's undo would never fire, and View > Reload would throw a drawing away
 * on a stray Cmd+R.
 *
 * A disabled item does not claim its key, so the keystroke falls through to
 * the board. These get switched off while the board has focus and switched
 * back on the moment it does not, leaving every other window untouched.
 */
const BOARD_STOLEN_ROLES = new Set(['undo', 'redo', 'reload', 'forcereload']);
function setBoardMenuKeysFree(free) {
  if (process.platform !== 'darwin') return;
  try {
    const menu = Menu.getApplicationMenu();
    if (!menu) return;
    const walk = (items) => {
      for (const item of items) {
        if (item.role && BOARD_STOLEN_ROLES.has(String(item.role).toLowerCase())) item.enabled = !free;
        if (item.submenu) walk(item.submenu.items);
      }
    };
    walk(menu.items);
  } catch (e) {
    console.warn('[Casrion] Could not adjust the menu for the board:', e.message);
  }
}

// Belt and braces: whatever route focus took, the moment it lands on any other
// window the menu goes back to normal. Leaving Cmd+Z switched off for the note
// editor would be a far worse bug than the one this is fixing.
app.on('browser-window-focus', (_e, win) => {
  if (win !== boardWindow) setBoardMenuKeysFree(false);
});

// True once the user has actually asked to quit, so the board's close guard
// knows the difference between "Cmd+W" and "the app is going away".
let quitting = false;
app.on('before-quit', () => { quitting = true; });

// Fit the plate to whichever monitor the user is on, keeping 16:9 for the
// drawing area and leaving room for the toolbar and footer.
function showBoardWindow(payload) {
  const { screen } = require('electron');
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const CHROME = 96;  // toolbar + footer + the stage's padding
  let w = Math.min(1200, Math.round(wa.width * 0.86));
  let h = Math.round((w - 24) * 9 / 16) + CHROME;
  const maxH = Math.round(wa.height * 0.9);
  if (h > maxH) {
    h = maxH;
    w = Math.round((h - CHROME) * 16 / 9) + 24;
  }
  boardWindow.setBounds({
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: Math.round(wa.y + (wa.height - h) / 2),
    width: w,
    height: h
  });
  boardWindow.webContents.send('board-open', payload);
  raiseBoard();
}

let boardOpening = false;
// The note the open board belongs to. Saving checks this, so a board can never
// land in a different note than the one it was started from.
let boardNotePath = null;

function boardHasFocus() {
  return !!(boardWindow && !boardWindow.isDestroyed() && boardWindow.isVisible() && boardWindow.isFocused());
}

// Bringing the board back to the front. On macOS focusing a window does not
// make its app the active one, so a board left behind another program would
// stay behind it; the app has to be raised first.
function raiseBoard() {
  if (process.platform === 'darwin') app.focus({ steal: true });
  // Cmd+M is the stock menu's Minimize, and a board with no taskbar button
  // would have nowhere to come back from.
  if (boardWindow.isMinimized()) boardWindow.restore();
  boardWindow.show();
  boardWindow.focus();
}

async function openBoard(relPath) {
  if (boardOpening) return;

  // Opening on top of a board that is already up would silently throw away
  // whatever is drawn on it. Bring it forward instead.
  if (boardWindow && !boardWindow.isDestroyed() && boardWindow.isVisible()) {
    raiseBoard();
    showOverlayNotification('The board is already open', 'error');
    return;
  }

  boardOpening = true;
  try {
    if (!boardWindow || boardWindow.isDestroyed()) {
      createBoardWindow();
      await new Promise((resolve) => boardWindow.webContents.once('did-finish-load', resolve));
    }

    // Editing an existing board: hand it the file so it can pick the strokes
    // back up. A board that will not read still opens, blank and saying so,
    // rather than leaving the user with a dead shortcut.
    let svg = null;
    let missing = false;
    if (relPath && activeFilePath) {
      const noteDir = path.dirname(activeFilePath);
      const target = path.normalize(path.join(noteDir, relPath));
      const rel = path.relative(path.join(noteDir, 'assets'), target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        console.warn('[Casrion] Refused to open a board outside the note assets:', relPath);
        return;
      }
      try {
        svg = fs.readFileSync(target, 'utf8');
      } catch (e) {
        missing = true;
        console.warn('[Casrion] Could not read board:', relPath, e.message);
      }
    }

    boardNotePath = activeFilePath;
    showBoardWindow({ relPath: relPath || null, svg, missing });
  } finally {
    boardOpening = false;
  }
}

function showQuickInputPopup() {
  // Open on whichever monitor the user is working on
  const { screen } = require('electron');
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  quickInputWindow.setPosition(
    Math.round(wa.x + wa.width / 2 - 300),
    Math.round(wa.y + wa.height * 0.22)
  );
  quickInputWindow.webContents.send('quick-input-context', {
    fileName: activeFilePath ? path.basename(activeFilePath) : null
  });
  quickInputWindow.show();
  quickInputWindow.focus();
}

function toggleQuickInput() {
  // Normally pre-created shortly after launch; if the hotkey wins that race,
  // build it now and pop it up as soon as its page is ready.
  if (!quickInputWindow || quickInputWindow.isDestroyed()) {
    createQuickInputWindow();
    quickInputWindow.webContents.once('did-finish-load', () => {
      if (quickInputWindow && !quickInputWindow.isDestroyed()) showQuickInputPopup();
    });
    return;
  }
  if (quickInputWindow.isVisible()) {
    quickInputWindow.hide();
    return;
  }
  showQuickInputPopup();
}

// Typed drafts can mix block types in one go (a heading, some text, then a
// quote). Blank lines between different block kinds keep each one rendering
// as its own block instead of merging into the previous paragraph.
function spaceAuthoredBlocks(lines) {
  const kindOf = (l) => {
    const t = l.trim();
    if (!t) return 'blank';
    if (/^#{1,6}\s/.test(t)) return 'heading';
    if (/^([-*]|\d+\.)\s/.test(t)) return 'list';
    if (/^>\s?/.test(t)) return 'quote';
    return 'text';
  };
  const out = [];
  let prev = 'blank';
  for (const line of lines) {
    const kind = kindOf(line);
    if (kind === 'blank') { out.push(line); prev = 'blank'; continue; }
    // Every heading starts a new block, even after another heading
    if (prev !== 'blank' && (kind !== prev || kind === 'heading')) out.push('');
    out.push(line);
    prev = kind;
  }
  return out.join('\n');
}

// Insert text the user typed in the quick popup. Unlike clipboard captures
// this is deliberate authored content — no normalization, just placement.
function insertTypedText(rawText, mode) {
  if (!activeFilePath) {
    showOverlayNotification('No file selected!', 'error');
    return;
  }
  const text = String(rawText || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (!text.trim()) return;

  pushUndo();
  // A quick note is the user's own writing: if it lands under an earlier
  // source stamp it must not be attributed to that source.
  ensureStampBoundary();
  const lines = text.split('\n');
  let notifType = 'text';
  // Markdown the user typed themselves ("# Heading", "- item", "> quote")
  const authoredMarkdown = /^(#{1,6}\s|[-*]\s|\d+\.\s|>\s?|!\[|```)/;

  if (mode === 'h1' || mode === 'h2' || mode === 'h3') {
    const prefix = mode === 'h1' ? '# ' : mode === 'h2' ? '## ' : '### ';
    insertionLine = insertNewLineAfter(lines.map((l) => (l.trim() ? prefix + l.trim() : l)).join('\n'), insertionLine);
    notifType = 'heading';
  } else if (mode === 'bullet') {
    insertionLine = insertNewLineAfter(lines.map((l) => (l.trim() ? '- ' + l.trim() : l)).join('\n'), insertionLine);
  } else if (mode === 'quote') {
    insertionLine = insertNewLineAfter(lines.map((l) => '> ' + l).join('\n'), insertionLine);
  } else if (lines.length > 1 || authoredMarkdown.test(text.trim())) {
    // Multi-line drafts and hand-written markdown get their own lines;
    // appendToLine would glue them onto the current line as one run-on.
    insertionLine = insertNewLineAfter(spaceAuthoredBlocks(lines), insertionLine);
  } else {
    insertionLine = appendToLine(text, insertionLine);
  }

  const firstLine = lines[0];
  showOverlayNotification(firstLine.substring(0, 30) + (firstLine.length > 30 || lines.length > 1 ? '...' : ''), notifType);
  notifyRendererFileUpdated();
}

function setStampSource(enabled) {
  settings.stampSource = !!enabled;
  saveSettings();
  // The throwaway lookup only exists to warm the Windows PowerShell helper.
  // On macOS it would spawn osascript and could pop an out-of-context
  // Automation prompt, so the first real capture does the work there.
  if (settings.stampSource) { startTitleHelper(); if (process.platform === 'win32') getForegroundSourceInfo(5000); } else { stopTitleHelper(); }
  lastStamp = { title: null, file: null };
  refreshTrayMenu();
  // The tray and the window paperclip both toggle this — push the new state
  // to the renderer so the two can never show different answers.
  notifyRendererFileUpdated();
}

function refreshTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Casrion', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: 'Add source to captures',
      type: 'checkbox',
      checked: !!settings.stampSource,
      click: (item) => setStampSource(item.checked)
    },
    {
      label: `Explain selection (double-tap ${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'})`,
      type: 'checkbox',
      checked: settings.explainEnabled !== false,
      click: (item) => explainFeature.setEnabled(item.checked)
    },
    // macOS gates the explain feature behind two separate privacy permissions;
    // give the user one-click access to both panes since they are easy to miss.
    ...(process.platform === 'darwin' ? [
      {
        label: 'Explain permissions (macOS)',
        submenu: [
          { label: 'Open Accessibility settings (read selection)', click: () => openMacPrivacyPane('Privacy_Accessibility') },
          // Not just the gesture: the same event tap is what notices you
          // clicking away from the popup, so without this it will not close.
          { label: 'Open Input Monitoring settings (double-tap Cmd, click to close)', click: () => openMacPrivacyPane('Privacy_ListenEvent') }
        ]
      }
    ] : []),
    { type: 'separator' },
    { label: 'Quit Casrion', click: () => quitApp() }
  ]);
  tray.setContextMenu(contextMenu);
}

// Deep-link straight to a macOS Privacy & Security pane (Accessibility,
// Input Monitoring, ...). The anchor names are Apple's internal pane ids.
function openMacPrivacyPane(anchor) {
  if (process.platform !== 'darwin') return;
  shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`)
    .catch(() => {});
}

function createTray() {
  // On Windows a multi-size .ico lets the shell pick the right resolution
  // for the current DPI scale — a pre-resized 16px PNG looks blurry at 150%+.
  // tray.ico is the logo cropped to its visible bounds, so the mark fills
  // the tiny tray slot instead of floating in transparent padding.
  if (process.platform === 'win32') {
    tray = new Tray(path.join(__dirname, 'icons', 'tray.ico'));
  } else {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icons', 'icon_32.png'));
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
  }
  tray.setToolTip('Casrion');
  refreshTrayMenu();
  tray.on('click', () => showMainWindow());
}

// ─── Source stamps (opt-in): who/where a capture came from ────
// A persistent PowerShell helper reads the foreground window title, owning
// app, and (for browsers) the address bar URL on demand (Electron has no API
// for other apps' windows). The address bar is read through Windows UI
// Automation, which covers copies where the page puts no URL in the
// clipboard (site "copy" buttons usually copy plain text only). Only runs
// while the tray option "Add source to captures" is enabled.
// Protocol: each request is an id line on stdin; the reply line echoes the
// id followed by tab-separated fields, so late replies can never be matched
// to the wrong request.

const TITLE_HELPER_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$browsers = @{ chrome = 1; msedge = 1; brave = 1; firefox = 1; opera = 1; opera_gx = 1; vivaldi = 1; chromium = 1; arc = 1 }
$editCache = @{}
function Get-BrowserUrl($h, $procName) {
  if (-not $browsers.ContainsKey($procName)) { return '' }
  $key = $h.ToInt64()
  for ($attempt = 0; $attempt -lt 2; $attempt++) {
    try {
      $edit = $editCache[$key]
      if ($null -eq $edit) {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
        $condType = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
        $condVal = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty, $true)
        $cond = New-Object System.Windows.Automation.AndCondition($condType, $condVal)
        $edit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        if ($null -eq $edit) { return '' }
        $editCache[$key] = $edit
      }
      $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      return [string]$vp.Current.Value
    } catch {
      $editCache.Remove($key)
    }
  }
  return ''
}
$tab = [string][char]9
while ($true) {
  $reqId = [Console]::In.ReadLine()
  if ($null -eq $reqId) { break }
  $h = [FG]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][FG]::GetWindowText($h, $sb, 512)
  $title = $sb.ToString()
  $procId = [uint32]0
  [void][FG]::GetWindowThreadProcessId($h, [ref]$procId)
  $procName = ''
  $desc = ''
  try {
    $p = [System.Diagnostics.Process]::GetProcessById([int]$procId)
    $procName = $p.ProcessName.ToLowerInvariant()
    try { $desc = [string]$p.MainModule.FileVersionInfo.FileDescription } catch { $desc = '' }
  } catch { }
  $url = ''
  try { $url = [string](Get-BrowserUrl $h $procName) } catch { $url = '' }
  $clean = @()
  foreach ($f in @($reqId.Trim(), $title, $procName, $desc, $url)) {
    $clean += (([string]$f) -replace "[\\r\\n\\t]+", ' ')
  }
  [Console]::Out.WriteLine([string]::Join($tab, $clean))
}
`;

let titleHelper = null;
let titleHelperPending = new Map();
let titleHelperSeq = 0;
let lastStamp = { title: null, url: null, file: null };

function startTitleHelper() {
  if (titleHelper || process.platform !== 'win32') return;
  try {
    const encoded = Buffer.from(TITLE_HELPER_SCRIPT, 'utf16le').toString('base64');
    titleHelper = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    titleHelper.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        const parts = line.split('\t');
        const resolve = titleHelperPending.get(parts[0]);
        if (resolve) {
          titleHelperPending.delete(parts[0]);
          resolve({ title: parts[1] || '', proc: parts[2] || '', app: parts[3] || '', url: parts[4] || '' });
        }
      }
    });
    titleHelper.on('exit', () => {
      titleHelper = null;
      for (const resolve of titleHelperPending.values()) resolve(null);
      titleHelperPending.clear();
    });
  } catch (e) {
    console.error('[Casrion] Title helper failed to start:', e.message);
    titleHelper = null;
  }
}

function stopTitleHelper() {
  if (titleHelper) {
    try { titleHelper.kill(); } catch { /* already gone */ }
    titleHelper = null;
  }
  for (const resolve of titleHelperPending.values()) resolve(null);
  titleHelperPending.clear();
}

// The first address bar lookup on a freshly opened browser window makes the
// browser build its accessibility tree, which can take most of a second, so
// the timeout is generous. Repeat lookups hit the helper's element cache and
// come back in a few milliseconds.
function getForegroundSourceInfo(timeoutMs = 1200, force = false, wantUrl = true) {
  // Explain lookups need the helper even when source stamping is off
  if (!settings.stampSource && !force) return Promise.resolve(null);
  // macOS has no PowerShell/UI-Automation helper. The frontmost app is named
  // by lsappinfo (stock tool, zero permissions); the explain hook's app name
  // is only a fast path / fallback, because it needs an Accessibility
  // selection read that regularly comes back empty. For a front browser the
  // page URL is asked via AppleScript. The URL step is skipped for explain
  // (wantUrl=false): it spawns osascript and would trigger a per-browser
  // Automation prompt the explain flow does not need.
  if (process.platform === 'darwin') {
    // Asking the hook for the app name is not free: it is a full Accessibility
    // selection read of the frontmost app, served by that app's own UI thread.
    // Explain is about to do one anyway, so there it is genuinely a fast path.
    // A capture is not, and this used to run the read on every single capture
    // and then call lsappinfo regardless, throwing the expensive answer away.
    if (!wantUrl) {
      let hookApp = '';
      try { hookApp = explainFeature.getForegroundAppName(); } catch { hookApp = ''; }
      if (hookApp) {
        return Promise.resolve({ title: '', proc: hookApp.toLowerCase(), app: hookApp, url: '' });
      }
    }
    return macFrontAppNameCached(Math.min(timeoutMs, 800)).then((front) => {
      let app = front;
      // Only worth paying for the read once the free tool has actually failed.
      if (!app) {
        try { app = explainFeature.getForegroundAppName(); } catch { app = ''; }
      }
      if (!app) return null;
      const base = { title: '', proc: app.toLowerCase(), app, url: '' };
      const script = wantUrl ? macBrowserUrlScript(app) : null;
      if (!script) return base;
      // A normal read is ~100-200ms; the cap keeps the stamp from waiting on a
      // first-time Automation prompt (that capture just goes out without a URL).
      return getMacBrowserUrl(script, 900).then((url) => ({ ...base, url: url || '' }));
    });
  }
  startTitleHelper();
  if (!titleHelper) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = String(++titleHelperSeq);
    const timer = setTimeout(() => {
      titleHelperPending.delete(id);
      resolve(null);
    }, timeoutMs);
    titleHelperPending.set(id, (info) => { clearTimeout(timer); resolve(info); });
    try { titleHelper.stdin.write(id + '\n'); } catch {
      clearTimeout(timer);
      titleHelperPending.delete(id);
      resolve(null);
    }
  });
}

// Name the frontmost app via lsappinfo, a stock macOS tool that needs no
// privacy permission at all. This is what makes source stamping work even
// when Accessibility is missing or the front app hides its selection.
/**
 * macOS pays far more for a source stamp than Windows does.
 *
 * Windows answers out of one long-lived helper process, measured at roughly
 * 5ms a capture. macOS spawns /bin/sh plus two lsappinfo calls to name the
 * frontmost app, and then, only once that has come back, an osascript to ask
 * the browser for its URL. Four processes in two sequential stages, on every
 * single capture. That is what makes fast note taking feel heavy on a Mac.
 *
 * The app name is the half worth caching, because macOS says for free when it
 * changes: AppKit posts an activation notification whenever a different app is
 * brought to the front. So the name only has to be looked up again after a
 * real switch, and the URL step stops queueing behind it.
 *
 * The URL is deliberately NOT cached. Changing browser tab changes the URL and
 * posts no notification at all, so a cached one would eventually stamp a quote
 * with a page it did not come from. Being slow beats being wrong.
 *
 * Every failure degrades to exactly the old behaviour: if the subscription
 * throws, the flag just stays dirty and every capture looks the app up the long
 * way. The TTL is a second belt for the case where notifications stop arriving.
 */
let macFrontApp = '';
let macFrontAppAt = 0;
let macFrontAppDirty = true;
const MAC_FRONT_APP_TTL = 2000;

function watchMacFrontApp() {
  if (process.platform !== 'darwin') return;
  try {
    systemPreferences.subscribeWorkspaceNotification(
      'NSWorkspaceDidActivateApplicationNotification',
      () => { macFrontAppDirty = true; }
    );
  } catch (e) {
    // Nothing to repair: dirty forever means look it up every time, as before.
    macFrontAppDirty = true;
    console.warn('[Casrion] No app-activation notifications:', e.message);
  }
}

function macFrontAppNameCached(timeoutMs) {
  if (!macFrontAppDirty && macFrontApp && Date.now() - macFrontAppAt < MAC_FRONT_APP_TTL) {
    return Promise.resolve(macFrontApp);
  }
  return getMacFrontAppName(timeoutMs).then((name) => {
    if (name) {
      macFrontApp = name;
      macFrontAppAt = Date.now();
      macFrontAppDirty = false;
    }
    return name;
  });
}

function getMacFrontAppName(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn('/bin/sh', ['-c', 'lsappinfo info -only name "$(lsappinfo front)"'],
        { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return finish(''); }
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(''); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); finish(''); });
    child.on('close', () => {
      clearTimeout(timer);
      // Output shape: "name"="Safari" (older builds may drop the key quotes)
      const m = /"?name"?\s*=\s*"([^"]*)"/.exec(out) || /=\s*"([^"]*)"\s*$/.exec(out.trim());
      finish(m && m[1] ? m[1].trim() : '');
    });
  });
}

// AppleScript that returns the front tab's URL for a known browser, or null
// for anything else. Safari and the Chromium family expose it differently.
// Matching is exact-name (not substring): "tell application" LAUNCHES the
// target if it is not running, so a fuzzy match against an app that merely
// contains "arc" or "edge" in its name would open a browser mid-capture.
// The script targets the app's own name, which also reaches Beta/Canary
// builds ("Google Chrome Beta" is its own AppleScript application).
function macBrowserUrlScript(app) {
  const name = String(app || '').trim().replace(/["\\]/g, '');
  const a = name.toLowerCase();
  if (a === 'safari' || a.startsWith('safari technology')) {
    return `tell application "${name}" to return URL of front document`;
  }
  const CHROMIUM = ['google chrome', 'chrome', 'microsoft edge', 'brave browser',
    'arc', 'vivaldi', 'opera', 'chromium'];
  if (!CHROMIUM.some((k) => a === k || a.startsWith(k + ' '))) return null;
  return `tell application "${name}" to return URL of active tab of front window`;
}

// Run a one-shot AppleScript to read the browser URL. Fully defensive: hard
// timeout, killed on overrun, only a real http(s) URL is accepted, and any
// failure (browser closed, Automation permission denied) resolves to ''.
function getMacBrowserUrl(script, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return finish(''); }
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(''); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); finish(''); });
    child.on('close', () => {
      clearTimeout(timer);
      const u = out.trim();
      finish(/^https?:\/\//i.test(u) ? u : '');
    });
  });
}

function cleanSourceTitle(raw) {
  if (!raw) return null;
  let t = raw.trim();
  // Strip browser name suffixes and profile decorations
  for (let pass = 0; pass < 2; pass++) {
    t = t.replace(/\s+[-—–]\s+(Google Chrome|Microsoft Edge|Mozilla Firefox|Firefox|Brave|Opera|Chromium|Vivaldi|Arc)(\s+\(.*\))?$/i, '');
  }
  t = t.replace(/^\(\d+\)\s*/, '').trim(); // "(3) " unread counters
  // Never stamp our own windows (main window, help overlay, toasts)
  if (!t || /^Casrion\b/.test(t)) return null;
  return t.length > 90 ? t.slice(0, 90) + '…' : t;
}

// Browsers put the page address in the raw Windows clipboard HTML header
// ("SourceURL: https://...") whenever formatted content is copied. That
// gives the exact website for a capture with zero extra system access.
function getClipboardSourceUrl() {
  try {
    // Chromium browsers on macOS put the copied-from page address on the
    // pasteboard next to every copy (Safari has no equivalent, it falls back
    // to the front-tab AppleScript). Exact source, no permissions needed.
    if (process.platform === 'darwin') {
      const buf = clipboard.readBuffer('org.chromium.source-url');
      const url = buf && buf.length ? buf.toString('utf8').trim().replace(/[<>"]/g, '') : '';
      return /^https?:\/\//i.test(url) && url.length <= 400 ? url : null;
    }
    const raw = clipboard.readBuffer('HTML Format');
    if (!raw || raw.length === 0) return null;
    const head = raw.toString('utf8', 0, Math.min(raw.length, 2048));
    const m = /^SourceURL:(\S+)/im.exec(head);
    if (!m) return null;
    const url = m[1].trim().replace(/[<>"]/g, '');
    if (!/^https?:\/\//i.test(url) || url.length > 400) return null;
    return url;
  } catch {
    return null;
  }
}

// The browser address bar usually shows the page without its scheme
// ("en.wikipedia.org/wiki/..."). Accept that shape, reject anything that
// looks like a typed search, an internal page (chrome://...), or half-typed
// input, so a stamp never carries a made-up address.
function normalizeAddressBarUrl(raw) {
  if (!raw) return null;
  let u = String(raw).trim();
  if (!u || u.length > 400 || /\s/.test(u)) return null;
  if (!/^https?:\/\//i.test(u)) {
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}([/:?#]|$)/i.test(u)) return null;
    u = 'https://' + u;
  }
  return u.replace(/[<>"]/g, '');
}

// Friendly app name from the exe's version info ("Brave Browser", "Slack",
// "ChatGPT"). Only stamped when there is no URL: a web address already says
// where the capture came from, and the title often repeats the app anyway.
function cleanAppName(info, title, url) {
  if (!info || url) return null;
  let name = (info.app || '').trim();
  if (!name || /^casrion/i.test(name)) return null;
  if (title && title.toLowerCase().includes(name.toLowerCase())) return null;
  return name.length > 40 ? name.slice(0, 40) : name;
}

// Sample the capture's origin at the moment the hotkey fires by starting the
// foreground-window lookup (async, never blocks the handler). The clipboard's
// SourceURL header is deliberately NOT read here: reading the HTML clipboard
// format forces the source app to render it on demand, which can block the
// main process for seconds on large copies. It is read later, behind the toast.
function beginSourceStamp() {
  if (!settings.stampSource) return null;
  return { infoPromise: getForegroundSourceInfo() };
}

// The viewer attributes every block to the nearest stamp above it, so
// content added while stamping is OFF would silently inherit the last old
// stamp's source. Close that region once with an empty stamp (hidden in the
// viewer) so unstamped captures stay unattributed. Pure in-memory line scan:
// costs well under a millisecond and never touches the helper process.
function ensureStampBoundary() {
  if (!activeFilePath) return;
  const lines = getLines();
  const start = insertionLine >= 0 && insertionLine < lines.length ? insertionLine : lines.length - 1;
  for (let i = start; i >= 0; i--) {
    const m = /^<sub[^>]*>\s*(?:Source:\s*)?([\s\S]*?)<\/sub>/.exec(lines[i].trim());
    if (m) {
      if (m[1].trim()) {
        insertionLine = insertNewLineAfter('<sub></sub>', insertionLine);
        // The region is closed now; the next stamped capture must write a
        // fresh stamp even if it comes from the same source as before.
        lastStamp = { title: null, url: null, file: null };
      }
      return;
    }
  }
}

// Insert a small source line when the capture source changes (never repeats
// the same source back-to-back, so notes stay clean).
async function maybeStampSource(pending) {
  if (!activeFilePath) return;
  if (!settings.stampSource) { ensureStampBoundary(); return; }
  const sample = pending || beginSourceStamp();
  // The clipboard's own SourceURL is the page the text was copied from, so
  // it wins over the address bar (which is merely the page in front now).
  // Read it here, after the toast is on screen: forcing the HTML clipboard
  // format to render can block for a long time on large copies.
  const clipUrl = getClipboardSourceUrl();
  const info = await sample.infoPromise.catch(() => null);
  const title = cleanSourceTitle(info && info.title);
  const url = clipUrl || normalizeAddressBarUrl(info && info.url);
  const appName = cleanAppName(info, title, url);
  if (!title && !url && !appName) return;
  if (lastStamp.title === title && lastStamp.url === url && lastStamp.file === activeFilePath) return;
  lastStamp = { title, url, file: activeFilePath };
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const esc = (s) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const parts = [];
  if (title) parts.push(esc(title));
  if (url) parts.push(esc(url));
  if (appName) parts.push(esc(appName));
  parts.push(time);
  insertionLine = insertNewLineAfter(`<sub>Source: ${parts.join(' · ')}</sub>`, insertionLine);
}

// ─── Clipboard Capture (reads clipboard directly — no simulation) ──

// Formatting wrappers act on the plain snippet as-is (intentional inline emphasis)
const WRAPPER_MODES = {
  bold: (t) => `**${t}**`,
  italic: (t) => `*${t}*`,
  red: (t) => `<span style="color: #ef4444">${t}</span>`,
  green: (t) => `<span style="color: #10b981">${t}</span>`,
  blue: (t) => `<span style="color: #3b82f6">${t}</span>`
};

// ─── Reading the clipboard without believing a failed read ────
//
// Windows hands the clipboard to one process at a time. While another app has
// it open (a clipboard manager, Office, a screenshot tool still writing its
// bitmap) every read fails, and Electron reports that failure as "there is
// nothing on the clipboard at all" — indistinguishable from an empty one.
// That is how a perfectly good screenshot turns into "No image in clipboard".
// An empty format list is therefore treated as "ask again in a moment"; a
// non-empty one is trusted immediately, so the common path costs nothing.
const CLIP_RETRIES = 5;
const CLIP_RETRY_MS = 30;

// Deliberately blocking: these run inside the hotkey handler, where the whole
// point is to read the clipboard as it was when the key went down. The wait
// only ever happens on a failed read (max ~150ms), never on the happy path.
// Atomics.wait parks the thread instead of burning a core on a spin loop.
const waitCell = new Int32Array(new SharedArrayBuffer(4));
function waitSync(ms) {
  try {
    Atomics.wait(waitCell, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* no Atomics here: hold the line the dumb way */ }
  }
}

// The clipboard's formats, retried while the list comes back empty.
function clipboardFormats() {
  for (let i = 0; ; i++) {
    const formats = clipboard.availableFormats();
    if (formats.length || i >= CLIP_RETRIES) return formats;
    waitSync(CLIP_RETRY_MS);
  }
}

function clipboardHasImage() {
  return clipboardFormats().some((f) => f.startsWith('image/'));
}

// The text of the last capture that went in. See clipboardTextSnapshot.
let lastCapturedText = null;

// Formats and text together, retried while the pair looks like a failed read:
// no formats at all, or formats that promise text which reads back empty.
//
// `suspectStale` closes a hole those two checks cannot see. Copying is not
// instant: the source app writes the clipboard a beat after the key goes down,
// and Chromium-based apps are the slowest at it. Press Ctrl+C and Ctrl+Shift+C
// quickly enough and the read lands in that gap, where the clipboard still
// holds the PREVIOUS copy. That reads back as perfectly valid non-empty text,
// so every check above is satisfied and the wrong paragraph gets kept, quietly,
// with a toast saying it worked.
//
// There is no clipboard sequence number available to us (Electron does not
// expose one and neither does the hook), but the rhythm gives one away: it is
// copy, capture, copy, capture, so the stale value is almost always the text
// that was captured last time. Treat that as "the copy has not landed yet" and
// give it the same short grace an empty read already gets. It is verified,
// never trusted: if it still reads the same after the retries it goes in
// anyway, because the user is allowed to keep the same thing twice.
function clipboardTextSnapshot(suspectStale) {
  for (let i = 0; ; i++) {
    const formats = clipboard.availableFormats();
    const text = clipboard.readText();
    const claimsText = formats.some((f) => f.startsWith('text/'));
    const looksRead = formats.length && (text || !claimsText);
    const looksStale = suspectStale != null && text !== '' && text === suspectStale;
    if ((looksRead && !looksStale) || i >= CLIP_RETRIES) return { formats, text };
    waitSync(CLIP_RETRY_MS);
  }
}

// The bitmap itself. A read can still come back empty right after the formats
// said otherwise (the owning app releases it mid-read), so retry that too.
function readClipboardImage() {
  for (let i = 0; ; i++) {
    const image = clipboard.readImage();
    if (!image.isEmpty() || i >= CLIP_RETRIES) return image;
    waitSync(CLIP_RETRY_MS);
  }
}

// Guards, clipboard sniff and the confirmation toast. Runs synchronously in
// the hotkey handler itself, so the toast appears the instant the key goes
// down even when the capture chain is still busy committing earlier work.
// Only cheap clipboard calls here: availableFormats never renders anything,
// and plain text renders fast. The HTML flavor (which the source app builds
// on demand, sometimes over seconds) is read later, behind the toast.
function preflightText(mode) {
  if (!activeFilePath) {
    showOverlayNotification('No file selected!', 'error');
    return null;
  }
  const { formats, text: rawText } = clipboardTextSnapshot(lastCapturedText);
  const hasHtml = formats.includes('text/html');

  if (WRAPPER_MODES[mode]) {
    // Drop any color the snippet already carries so Alt+R/G/B always applies
    // a single clean color instead of nesting inside an old one.
    const snippet = stripColorMarkup((rawText || '').trim()).trim();
    if (!snippet) {
      showOverlayNotification('Copy plain text first for formatting captures', 'error');
      return null;
    }
    showOverlayNotification(snippet.substring(0, 30) + (snippet.length > 30 ? '...' : ''), 'text');
    lastCapturedText = rawText;
    return { rawText, hasHtml, snippet };
  }

  if ((!rawText || rawText.trim().length === 0) && !hasHtml) {
    showOverlayNotification(`Clipboard is empty. Copy text first (${MOD_LABEL}+C)`, 'error');
    return null;
  }
  const previewLine = (rawText || '').trim().split('\n')[0];
  showOverlayNotification(
    previewLine
      ? previewLine.substring(0, 30) + (previewLine.length > 30 || (rawText || '').trim().includes('\n') ? '...' : '')
      : 'Captured',
    mode === 'append' ? 'text' : 'heading'
  );
  // Only on the paths that actually keep something, so a rejected capture
  // never poisons the staleness signal for the next one.
  lastCapturedText = rawText;
  return { rawText, hasHtml };
}

async function captureText(mode = 'append', pendingStamp = null, pre = null) {
  const p = pre || preflightText(mode);
  if (!p) return;

  if (WRAPPER_MODES[mode]) {
    pushUndo();
    insertionLine = appendToLine(WRAPPER_MODES[mode](p.snippet), insertionLine);
    console.log('[Casrion] Captured (' + mode + ') at line', insertionLine);
    notifyRendererFileUpdated();
    return;
  }

  // Append/heading captures go through normalization: AI-chat copies, KaTeX
  // math, spreadsheet tables and glued text all become clean markdown.
  const rawHtml = p.hasHtml ? clipboard.readHTML() : '';
  const { content, structured } = normalizeCapture(p.rawText, rawHtml);
  if (!content) {
    showOverlayNotification(`Clipboard is empty. Copy text first (${MOD_LABEL}+C)`, 'error');
    return;
  }

  pushUndo();
  await maybeStampSource(pendingStamp);

  if (mode === 'append') {
    insertionLine = structured
      ? insertNewLineAfter(content, insertionLine)
      : appendToLine(content, insertionLine);
  } else {
    const prefix = mode === 'h1' ? '# ' : mode === 'h2' ? '## ' : '### ';
    insertionLine = insertNewLineAfter(prefix + content, insertionLine);
  }

  console.log('[Casrion] Captured (' + mode + ') at line', insertionLine, ':', content.substring(0, 50));
  notifyRendererFileUpdated();
}

// Sniff + toast for image captures, run in the hotkey handler. The cheap
// format list decides the toast (decoding the bitmap of a 4K screenshot takes
// real time), but the bitmap is then grabbed in the same breath, before the
// handler returns: by the time the capture queue drains, the user may have
// copied something else, and any app on the machine can wipe the clipboard in
// between. What lands in the note is what was on the clipboard at key-down.
function preflightImage() {
  if (!activeFilePath) {
    showOverlayNotification('No file selected!', 'error');
    return null;
  }
  if (!clipboardHasImage()) {
    showOverlayNotification(`No image in clipboard. ${SCREENSHOT_HINT}`, 'error');
    return null;
  }
  showOverlayNotification('Image Saved', 'image');
  const image = readClipboardImage();
  if (image.isEmpty()) {
    // The formats promised a bitmap a moment ago, so this is a lost race, not
    // an empty clipboard. Replace the toast we just showed.
    showOverlayNotification('Could not read that image. Copy it again', 'error');
    return null;
  }
  return { image };
}

async function captureImage(pendingStamp = null, pre = null) {
  const p = pre || preflightImage();
  if (!p) return;
  const image = p.image || readClipboardImage();
  if (!image.isEmpty()) {
    pushUndo();
    await maybeStampSource(pendingStamp);
    const assetsDir = path.join(path.dirname(activeFilePath), 'assets');
    let maxNum = 0;
    if (fs.existsSync(assetsDir)) {
      const files = fs.readdirSync(assetsDir);
      for (const file of files) {
        if (file.toLowerCase().endsWith('.png')) {
          const num = parseInt(file.substring(0, file.length - 4), 10);
          if (!isNaN(num) && num > maxNum) {
            maxNum = num;
          }
        }
      }
    } else {
      fs.mkdirSync(assetsDir, { recursive: true });
    }
    const filename = `${maxNum + 1}.png`;
    const imagePath = path.join(assetsDir, filename);
    fs.writeFileSync(imagePath, image.toPNG());

    const fileUrl = 'assets/' + filename;
    insertionLine = insertNewLineAfter(`![Screenshot](${fileUrl})`, insertionLine);
    console.log('[Casrion] Captured image:', filename, 'at line', insertionLine);
    notifyRendererFileUpdated();
  } else {
    showOverlayNotification(`No image in clipboard. ${SCREENSHOT_HINT}`, 'error');
  }
}

function newParagraph() {
  if (!activeFilePath) return;
  const lines = getLines();
  const idx = insertionLine < 0 || insertionLine >= lines.length ? lines.length - 1 : insertionLine;
  const curBlank = lines[idx].trim() === '';
  const prevBlank = idx === 0 || lines[idx - 1].trim() === '';

  // Already parked on a fresh empty line: pressing the shortcut again must
  // not stack more blank lines into the document.
  if (curBlank && prevBlank) {
    insertionLine = idx;
    notifyRendererFileUpdated();
    return;
  }

  pushUndo();
  if (curBlank) {
    // The current blank line becomes the separator; add only the target line
    insertionLine = insertBlankLine(idx);
  } else {
    // One blank line separates paragraphs, the second is where text lands
    insertionLine = insertBlankLine(insertBlankLine(idx));
  }
  console.log('[Casrion] New paragraph at line', insertionLine);
  notifyRendererFileUpdated();
}

// Guard + toast for code captures, run in the hotkey handler.
function preflightCode() {
  if (!activeFilePath) {
    showOverlayNotification('No file selected!', 'error');
    return null;
  }
  const { text } = clipboardTextSnapshot();
  if (!text || text.trim().length === 0) {
    showOverlayNotification(`Clipboard is empty. Copy code first (${MOD_LABEL}+C)`, 'error');
    return null;
  }
  showOverlayNotification('Code Block Added', 'code');
  return { text };
}

async function captureCodeBlock(pendingStamp = null, pre = null) {
  const p = pre || preflightCode();
  if (!p) return;
  pushUndo();
  await maybeStampSource(pendingStamp);
  const codeBlock = '```\n' + p.text + '\n```';
  const lines = getLines();
  const lineNum = insertionLine;

  if (lineNum < 0 || lineNum >= lines.length) {
    const codeLines = codeBlock.split('\n');
    lines.push('', ...codeLines);
    writeFileAtomic(activeFilePath, lines.join('\n'));
    insertionLine = lines.length - 1;
  } else {
    const codeLines = codeBlock.split('\n');
    lines.splice(lineNum + 1, 0, '', ...codeLines);
    writeFileAtomic(activeFilePath, lines.join('\n'));
    insertionLine = lineNum + 1 + codeLines.length;
  }

  console.log('[Casrion] Code block added at line', insertionLine);
  notifyRendererFileUpdated();
}

function toggleHelpOverlay() {
  // Built on first use rather than at launch, so the renderer process only
  // exists for people who actually open the help panel. Show it once ready.
  if (!helpOverlayWindow || helpOverlayWindow.isDestroyed()) {
    createHelpOverlay();
    helpOverlayWindow.once('ready-to-show', () => {
      if (helpOverlayWindow && !helpOverlayWindow.isDestroyed()) helpOverlayWindow.show();
    });
    return;
  }
  if (helpOverlayWindow.isVisible()) {
    helpOverlayWindow.hide();
  } else {
    helpOverlayWindow.show();
  }
}

// ─── Voice Recording ───────────────────────────────────────
async function toggleRecording() {
  if (!activeFilePath) {
    showOverlayNotification('No file selected!', 'error');
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    showOverlayNotification('App window unavailable. Cannot record', 'error');
    isRecording = false;
    return;
  }

  isRecording = !isRecording;
  if (isRecording) {
    // macOS gates the microphone behind a system permission (TCC). Ask for it
    // before the renderer's getUserMedia call, which would otherwise fail
    // silently the very first time until the user granted access elsewhere.
    if (process.platform === 'darwin') {
      try {
        const status = systemPreferences.getMediaAccessStatus('microphone');
        if (status !== 'granted') {
          const ok = await systemPreferences.askForMediaAccess('microphone');
          if (!ok) {
            isRecording = false;
            showOverlayNotification('Microphone access is off. Enable it in System Settings > Privacy > Microphone', 'error', 5000);
            return;
          }
        }
      } catch { /* older macOS without the API: fall through and try anyway */ }
    }
    console.log('[Casrion] Starting voice recording...');
    // The recorder lives in the (possibly hidden and throttled) main window
    // renderer — wake it to full speed for the duration of the recording.
    mainWindow.webContents.setBackgroundThrottling(false);
    recordingConfirmed = false;
    mainWindow.webContents.send('start-recording');
    showOverlayNotification(`Recording... (Press ${MOD_LABEL}+Shift+M to stop)`, 'mic', 0);
    // If the renderer never gets a microphone open (none plugged in, Windows
    // privacy settings blocking desktop apps, another app holding it, a wedged
    // renderer), nothing would ever clear that sticky toast and the next press
    // would just look like it did nothing. Give the start a deadline.
    clearTimeout(recordingStartTimer);
    recordingStartTimer = setTimeout(() => {
      if (!isRecording || recordingConfirmed) return;
      isRecording = false;
      showOverlayNotification('Could not start recording. Check that a microphone is connected and allowed', 'error', 6000);
      rethrottleAfterRecording();
    }, RECORDING_START_TIMEOUT);
  } else {
    console.log('[Casrion] Stopping voice recording...');
    clearTimeout(recordingStartTimer);
    mainWindow.webContents.send('stop-recording');
  }
}

// Recording ended (saved or failed): if the window is parked in the tray,
// hand the renderer back to Chromium's throttler.
function rethrottleAfterRecording() {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    mainWindow.webContents.setBackgroundThrottling(true);
  }
}

// Quitting mid-recording: stop the recorder and give it a moment to hand the
// audio over, so the memo lands in the note instead of vanishing.
let recordingFlush = null;
function resolveRecordingFlush() {
  if (recordingFlush) {
    const done = recordingFlush;
    recordingFlush = null;
    done();
  }
}

function quitApp() {
  app.isQuiting = true;
  clearTimeout(recordingStartTimer);
  if (isRecording && mainWindow && !mainWindow.isDestroyed()) {
    isRecording = false;
    const flushed = new Promise((resolve) => {
      recordingFlush = resolve;
      setTimeout(resolve, 3000); // never hang the quit on a stuck recorder
    });
    mainWindow.webContents.send('stop-recording');
    flushed.then(() => app.quit());
    return;
  }
  app.quit();
}

// ─── Shortcuts ─────────────────────────────────────────────

// Captures are async (source stamping awaits the title helper), so rapid
// hotkey presses could interleave mid-file-write. Chain them so each capture
// fully lands before the next starts.
let captureChain = Promise.resolve();
function enqueueCapture(fn) {
  captureChain = captureChain
    .then(fn)
    .catch((e) => {
      // A capture that threw (folder unplugged, file locked, disk full) must
      // not fail silently after its toast already implied it worked.
      console.error('[Casrion] Capture failed:', e);
      showOverlayNotification('Could not save that capture. Check the note folder is still available', 'error', 4000);
    });
}

function registerShortcuts() {
  // Every capture splits in two: a synchronous preflight (guards, cheap
  // clipboard sniff, TOAST) that runs right here in the handler, and the
  // committed work that joins the capture queue. The toast therefore fires
  // the instant the key goes down, even if an earlier capture is still
  // finishing its source lookup or a heavy normalization in the queue.
  // Stamped captures also start the foreground-window lookup at key-down so
  // the slow part overlaps with whatever is still committing.
  const textCapture = (mode) => () => {
    const pre = preflightText(mode);
    if (!pre) return;
    const s = beginSourceStamp();
    enqueueCapture(() => captureText(mode, s, pre));
  };
  const plainText = (mode) => () => {
    const pre = preflightText(mode);
    if (!pre) return;
    enqueueCapture(() => captureText(mode, null, pre));
  };
  // CommandOrControl = Ctrl on Windows, Cmd on Mac, so one map serves both.
  // A few Cmd+Shift combos collide with reserved macOS system shortcuts that
  // an app cannot override, so those get macOS-specific accelerators:
  //   Cmd+Shift+3  = system screenshot   -> Heading 3 uses Cmd+Ctrl+3
  //   Cmd+Shift+Q  = system Log Out       -> Quick note uses Cmd+Shift+J (Jot)
  //   Option+R/G/B = type special glyphs  -> Colors use Cmd+Ctrl+R/G/B
  const isMac = process.platform === 'darwin';
  const KEY = {
    h3: isMac ? 'Command+Control+3' : 'CommandOrControl+Shift+3',
    quick: isMac ? 'Command+Shift+J' : 'CommandOrControl+Shift+Q',
    red: isMac ? 'Command+Control+R' : 'Alt+R',
    green: isMac ? 'Command+Control+G' : 'Alt+G',
    blue: isMac ? 'Command+Control+B' : 'Alt+B'
  };
  const shortcuts = {
    'CommandOrControl+Shift+C': textCapture('append'),                   // Append text
    'CommandOrControl+Shift+1': textCapture('h1'),                       // Heading 1
    'CommandOrControl+Shift+2': textCapture('h2'),                       // Heading 2
    [KEY.h3]: textCapture('h3'),                                         // Heading 3
    'CommandOrControl+Shift+V': () => {                                  // Paste image
      const pre = preflightImage();
      if (!pre) return;
      const s = beginSourceStamp();
      enqueueCapture(() => captureImage(s, pre));
    },
    'CommandOrControl+Shift+D': () => {                                  // Whiteboard
      if (!activeFilePath) {
        showOverlayNotification('Open a note first, then draw', 'error');
        return;
      }
      openBoard(null);
    },
    'CommandOrControl+Shift+N': () => {                                  // New paragraph
      if (activeFilePath) showOverlayNotification('New Line Started', 'paragraph');
      enqueueCapture(() => newParagraph());
    },
    'CommandOrControl+Shift+K': () => {                                  // Code block
      const pre = preflightCode();
      if (!pre) return;
      const s = beginSourceStamp();
      enqueueCapture(() => captureCodeBlock(s, pre));
    },
    // A global shortcut outranks the focused window, so while you are drawing
    // these would otherwise reach past the board and undo the note behind it.
    // On a Mac that is a trap with teeth: Cmd+Shift+Z IS redo everywhere else,
    // so the instinctive keypress would quietly edit the wrong thing. Inside
    // the board it therefore means what a Mac user means by it, redo, while on
    // Windows it keeps matching Casrion's own undo.
    'CommandOrControl+Shift+Z': () => {                                    // Undo
      if (boardHasFocus()) {
        boardWindow.webContents.send(isMac ? 'board-redo' : 'board-undo');
        return;
      }
      enqueueCapture(() => performUndo());
    },
    'CommandOrControl+Shift+Y': () => {                                    // Redo
      if (boardHasFocus()) { boardWindow.webContents.send('board-redo'); return; }
      enqueueCapture(() => performRedo());
    },
    'CommandOrControl+Shift+H': () => toggleHelpOverlay(),      // Help
    [KEY.quick]: () => toggleQuickInput(),                      // Quick note popup
    'CommandOrControl+Shift+E': () => explainFeature.triggerExplain(), // Explain selection
    'CommandOrControl+Shift+M': () => toggleRecording(),        // Voice Memo
    'CommandOrControl+Shift+B': plainText('bold'),                       // Bold
    'CommandOrControl+Shift+I': plainText('italic'),                     // Italic
    [KEY.red]: plainText('red'),                                         // Red Text
    [KEY.green]: plainText('green'),                                     // Green Text
    [KEY.blue]: plainText('blue')                                        // Blue Text
  };
  for (const [key, handler] of Object.entries(shortcuts)) {
    const success = globalShortcut.register(key, () => {
      console.log(`[Casrion] hotkey ${key} at ${Date.now()}`);
      handler();
    });
    console.log(`[Casrion] Shortcut ${key}: ${success ? 'registered' : 'FAILED'}`);
  }
  // Another app may own the explain hotkey; it is too central to silently
  // lose, so fall back to the Alt variant
  if (!globalShortcut.isRegistered('CommandOrControl+Shift+E')) {
    const ok = globalShortcut.register('CommandOrControl+Alt+E', () => explainFeature.triggerExplain());
    console.log(`[Casrion] Explain fallback CommandOrControl+Alt+E: ${ok ? 'registered' : 'FAILED'}`);
  }
}

// Folder names can contain characters that break URL parsing (#, ?, %).
// Encode just those so casrion:// URLs survive `new URL()` intact; the
// protocol handler decodes with decodeURIComponent.
function encodeDirForUrl(dir) {
  return dir.replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function hydrateContentForRenderer(content, filePath) {
  if (!content || !filePath) return content;
  const dir = encodeDirForUrl(path.dirname(filePath).replace(/\\/g, '/'));
  let hydrated = content.split(`](assets/`).join(`](casrion://${dir}/assets/`);
  hydrated = hydrated.split(`src="assets/`).join(`src="casrion://${dir}/assets/`);
  return hydrated;
}

// ─── IPC Handlers ──────────────────────────────────────────
function registerIPC() {
  ipcMain.handle('get-initial-state', () => buildStatePayload());

  // The renderer has a live recorder: the "Recording..." toast is now honest.
  // A whiteboard is written as a plain .svg into the same assets folder the
  // screenshots use, and referenced from the note as an ordinary markdown
  // image. That is deliberate: images already survive the editor's markdown
  // round trip and the relative-path migration above, so a board needs no
  // special handling anywhere else in the app.
  ipcMain.handle('save-board', (_event, { svg, relPath } = {}) => {
    try {
      if (!activeFilePath) return { error: 'Open a note first' };
      if (typeof svg !== 'string' || !svg.startsWith('<svg')) return { error: 'That board did not come out as an SVG' };
      // The note was switched underneath the board. Saving now would write the
      // drawing into the wrong note, so say so and keep it on screen instead.
      if (boardNotePath && boardNotePath !== activeFilePath) {
        return { error: `This board belongs to ${path.basename(boardNotePath)}. Open that note again to save it.` };
      }

      const noteDir = path.dirname(activeFilePath);
      const assetsDir = path.join(noteDir, 'assets');
      if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

      // Editing an existing board overwrites it in place, so the note keeps
      // pointing at the same file and nothing has to be re-inserted.
      if (relPath) {
        const target = path.normalize(path.join(noteDir, relPath));
        const rel = path.relative(assetsDir, target);
        // Never let a path from the renderer escape this note's assets folder.
        if (rel.startsWith('..') || path.isAbsolute(rel) || !/^board-\d+\.svg$/i.test(path.basename(target))) {
          return { error: 'That board path is not one of ours' };
        }
        writeFileAtomic(target, svg, 'utf8');
        console.log('[Casrion] Board updated:', path.basename(target));
        // The note's text is unchanged, so nothing would re-render the image.
        // Tell the window to pull the new file in.
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('board-saved', { relPath });
        }
        return { ok: true, relPath };
      }

      // Numbered separately from screenshots, whose numbering only ever scans
      // .png files — so the two can never collide.
      let maxNum = 0;
      for (const file of fs.readdirSync(assetsDir)) {
        const m = /^board-(\d+)\.svg$/i.exec(file);
        if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
      }
      const filename = `board-${maxNum + 1}.svg`;
      fs.writeFileSync(path.join(assetsDir, filename), svg, 'utf8');

      pushUndo();
      // A drawing is the user's own work, never the front window's.
      ensureStampBoundary();
      insertionLine = insertNewLineAfter(`![Board](assets/${filename})`, insertionLine);
      console.log('[Casrion] Board added:', filename, 'at line', insertionLine);
      notifyRendererFileUpdated();
      return { ok: true, relPath: `assets/${filename}` };
    } catch (e) {
      console.error('[Casrion] Board save failed:', e);
      return { error: 'Could not save the board. Check the note folder is still available' };
    }
  });

  // Hiding rather than closing keeps the window warm for the next drawing,
  // and hands focus back to whatever the user was working in.
  ipcMain.handle('close-board', () => {
    if (boardWindow && !boardWindow.isDestroyed()) boardWindow.hide();
  });

  // Double-clicking a board in the note asks for it by its relative path.
  ipcMain.handle('open-board', (_event, relPath) => openBoard(relPath || null));

  ipcMain.handle('recording-started', () => {
    recordingConfirmed = true;
    clearTimeout(recordingStartTimer);
  });

  ipcMain.handle('save-audio', (event, buffer, mimeType, durationMs) => {
    isRecording = false;
    recordingConfirmed = false;
    clearTimeout(recordingStartTimer);
    try {
      if (!activeFilePath) return;

      // Confirm on screen before touching the disk; the writes happen behind it.
      showOverlayNotification('Voice Memo Saved', 'mic');

      const assetsDir = path.join(path.dirname(activeFilePath), 'assets');
      if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

      // The recorder's real output format varies by machine — match the
      // extension to it so the player loads the file correctly everywhere.
      const mt = String(mimeType || 'audio/webm').toLowerCase();
      const ext = mt.includes('ogg') ? 'ogg' : mt.includes('mp4') ? 'm4a' : mt.includes('mpeg') ? 'mp3' : 'webm';
      const filename = `audio_${Date.now()}.${ext}`;
      const audioPath = path.join(assetsDir, filename);

      // A live-muxed WebM carries no length, which used to leave the player
      // guessing (badly). The recorder timed itself, so write that in.
      let bytes = Buffer.from(buffer);
      if (ext === 'webm') bytes = patchWebmDuration(bytes, durationMs);

      fs.writeFileSync(audioPath, bytes);
      console.log(`[Casrion] Saved audio to ${audioPath} (${Math.round(durationMs || 0)}ms)`);

      pushUndo();
      // A voice memo is the user's own recording, never the front window's work
      ensureStampBoundary();

      const relativePath = `assets/${filename}`;
      const audioMarkdown = `<audio controls src="${relativePath}"></audio>`;
      insertionLine = insertNewLineAfter(audioMarkdown, insertionLine);

      notifyRendererFileUpdated();
    } catch (e) {
      // The note's folder may have gone away mid-recording (USB/network
      // drive) — say so instead of losing the memo without a word.
      console.error('[Casrion] Failed to save voice memo:', e.message);
      showOverlayNotification('Could not save the voice memo. Check the note folder is still available', 'error', 4000);
    } finally {
      rethrottleAfterRecording();
      resolveRecordingFlush();
    }
  });

  // Renderer reports that recording could not start/produce audio, so the
  // main process state and the persistent "Recording..." toast get cleared.
  ipcMain.handle('recording-failed', (_event, message) => {
    isRecording = false;
    recordingConfirmed = false;
    clearTimeout(recordingStartTimer);
    showOverlayNotification(message || 'Recording failed. Check the microphone', 'error');
    rethrottleAfterRecording();
    resolveRecordingFlush();
  });

  let lastEditorUndoPush = 0;
  ipcMain.handle('save-file-content', (_event, { content }) => {
    if (!activeFilePath) return { error: 'No active file' };
    // Editor saves arrive continuously while typing; snapshot at most every
    // 15s so the undo stack isn't flooded by a single editing session.
    const now = Date.now();
    if (now - lastEditorUndoPush > 15000) {
      pushUndo();
      lastEditorUndoPush = now;
    }

    // Before saving, ensure any absolute memory paths are converted back to portable relative paths
    const dir = encodeDirForUrl(path.dirname(activeFilePath).replace(/\\/g, '/'));
    const escapeRegex = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dirPattern = escapeRegex(`casrion://${dir}/assets/`);
    
    // Use case-insensitive regex
    const mdRegex = new RegExp(`\\]\\(${dirPattern}`, 'gi');
    const htmlRegex = new RegExp(`src="${dirPattern}`, 'gi');
    
    content = content.replace(mdRegex, `](assets/`);
    content = content.replace(htmlRegex, `src="assets/`);
    
    writeFileAtomic(activeFilePath, content);
    console.log('[Casrion] File saved:', activeFilePath);
    return { success: true };
  });

  ipcMain.handle('export-document', async (_event, options = {}) => {
    const { isDarkMode } = options;
    if (!activeFilePath || !fs.existsSync(activeFilePath)) return { error: 'No active file' };
    
    try {
      let content = fs.readFileSync(activeFilePath, 'utf-8');
      
      // Inline images
      const imageRegex = /!\[([^\]]*)\]\((assets\/[^)]+)\)/g;
      content = content.replace(imageRegex, (match, alt, uri) => {
        try {
          const filePath = path.join(path.dirname(activeFilePath), uri);
          if (fs.existsSync(filePath)) {
            // Derive the real media type rather than pasting the extension in:
            // a whiteboard is image/svg+xml, and "image/svg" renders as nothing.
            const mime = ASSET_MIME[path.extname(filePath).toLowerCase()] || 'image/png';
            const base64 = fs.readFileSync(filePath).toString('base64');
            return `![${alt}](data:${mime};base64,${base64})`;
          }
        } catch (e) {
          console.error('[Casrion] Failed to inline image', uri, e);
        }
        return match;
      });

      // Inline audio (relative assets/ paths, plus legacy file:/// links)
      const audioRegex = /<audio\s+controls\s+src="([^"]+)"><\/audio>/g;
      content = content.replace(audioRegex, (match, uri) => {
        try {
          let audioFile = null;
          if (uri.startsWith('assets/')) {
            audioFile = path.join(path.dirname(activeFilePath), uri);
          } else if (uri.startsWith('file:///')) {
            audioFile = decodeURI(uri.substring(8));
          }
          if (audioFile && fs.existsSync(audioFile)) {
            // Same reason as the images above: an .m4a is audio/mp4, and the
            // extension pasted in raw ("audio/m4a") is not a media type.
            const mime = ASSET_MIME[path.extname(audioFile).toLowerCase()] || 'audio/webm';
            const base64 = fs.readFileSync(audioFile).toString('base64');
            return `<audio controls src="data:${mime};base64,${base64}"></audio>`;
          }
        } catch (e) {
          console.error('[Casrion] Failed to inline audio', uri, e);
        }
        return match;
      });

      const { marked } = require('marked');
      const markedKatex = require('marked-katex-extension');
      marked.use(markedKatex({ throwOnError: false, nonStandard: true, output: 'mathml' }));
      const htmlContent = marked(content);
      const title = path.basename(activeFilePath, '.md');
      const escapedTitle = title.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

      const template = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedTitle} - Exported</title>
  <style>
    body {
      margin: 0; padding: 40px;
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #f3efe8;
      color: #3f3c38;
      line-height: 1.6;
    }
    .document-container {
      max-width: 800px;
      margin: 0 auto;
      background: #faf8f4;
      padding: 60px 80px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.05);
    }
    h1, h2, h3 { color: #1c1917; margin-top: 1.5em; }
    h1 { font-size: 2.2rem; }
    a { color: #a16207; }
    img { max-width: 100%; height: auto; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin: 1em 0; }
    audio { margin: 1em 0; width: 100%; max-width: 400px; height: 54px; display: block; outline: none; border-radius: 27px; }
    pre { background: #26201c; color: #e9e2d8; padding: 16px; border-radius: 6px; overflow-x: auto; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.9em; }
    blockquote { border-left: 4px solid #d4a373; margin: 0; padding-left: 16px; color: #57534e; background: rgba(212, 163, 115, 0.09); padding: 12px 16px; border-radius: 0 6px 6px 0; }

    /* Table Styling */
    table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; }
    th, td { border: 1px solid #d6cfc4; padding: 0.6rem 0.8rem; text-align: left; }
    th { background: rgba(0, 0, 0, 0.03); font-weight: 650; }
    
    /* Dark Mode Support */
    ${isDarkMode ? `
    body { background: #110e0d; color: #cfc7bf; }
    .document-container { background: #201c19; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
    h1, h2, h3 { color: #f1ede8; }
    a { color: #d4a373; }
    blockquote { color: #c9c0b8; }
    th, td { border-color: rgba(255, 255, 255, 0.14); }
    th { background: rgba(255, 255, 255, 0.04); }
    ` : ''}

    /* Mobile Responsiveness */
    @media (max-width: 600px) {
      body { padding: 16px; }
      .document-container { padding: 30px 20px; }
      h1 { font-size: 1.8rem; }
      pre { padding: 12px; }
      audio { width: 100%; max-width: 100%; }
      table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <div class="document-container">
    ${htmlContent}
  </div>
</body>
</html>`;

      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Portable Document',
        defaultPath: path.join(path.dirname(activeFilePath), `${title}.html`),
        filters: [{ name: 'HTML Document', extensions: ['html'] }]
      });

      if (!result.canceled && result.filePath) {
        fs.writeFileSync(result.filePath, template, 'utf-8');
        return { success: true, filePath: result.filePath };
      }
      return { canceled: true };
    } catch (e) {
      console.error('[Casrion] Export failed:', e);
      return { error: e.message };
    }
  });

  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Add Folder to Workspace'
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const selected = result.filePaths[0];
      if (!settings.workingFolders.includes(selected)) {
        settings.workingFolders.push(selected);
        saveSettings();
      }

      const files = listMdFiles(selected);
      if (files.length > 0 && !activeFilePath) {
        activeFilePath = files[0].path;
        insertionLine = -1;
        settings.lastActiveFile = activeFilePath;
        saveSettings();
      }
      return buildStatePayload();
    }
    return null;
  });

  ipcMain.handle('remove-folder', (_event, folderPath) => {
    settings.workingFolders = settings.workingFolders.filter(f => f !== folderPath);
    saveSettings();

    // Auto-clear active file if it was inside the removed folder.
    // path.relative avoids the prefix trap ("C:\Notes2".startsWith("C:\Notes")).
    if (activeFilePath) {
      const rel = path.relative(folderPath, activeFilePath);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        activeFilePath = null;
        insertionLine = -1;
        settings.lastActiveFile = null;
        saveSettings();
      }
    }

    return buildStatePayload();
  });

  // Deletions are recoverable by design: everything goes to the Recycle Bin
  // via shell.trashItem, never a permanent unlink. If the OS refuses (rare:
  // network drives without a bin), we leave the file alone and say so.
  ipcMain.handle('delete-file', async (_event, filePath) => {
    try {
      if (fs.existsSync(filePath)) await shell.trashItem(filePath);
    } catch (e) {
      return { error: 'Could not move the note to the Recycle Bin: ' + e.message };
    }
    // Forget undo snapshots of the deleted note so undo can never write its
    // old content into whichever file becomes active next.
    undoStack = undoStack.filter((s) => s.filePath !== filePath);
    redoStack = redoStack.filter((s) => s.filePath !== filePath);
    if (activeFilePath === filePath) {
      activeFilePath = null;
      insertionLine = -1;
      settings.lastActiveFile = null;
      saveSettings();
    }
    return buildStatePayload();
  });

  ipcMain.handle('delete-folder', async (_event, folderPath) => {
    try {
      if (fs.existsSync(folderPath)) await shell.trashItem(folderPath);
    } catch (e) {
      return { error: 'Could not move the folder to the Recycle Bin: ' + e.message };
    }
    settings.workingFolders = (settings.workingFolders || []).filter((f) => f !== folderPath);
    // path.relative avoids the prefix trap ("C:\Notes2".startsWith("C:\Notes"))
    const isInside = (p) => {
      const rel = path.relative(folderPath, p);
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    undoStack = undoStack.filter((s) => !isInside(s.filePath));
    redoStack = redoStack.filter((s) => !isInside(s.filePath));
    if (activeFilePath && isInside(activeFilePath)) {
      activeFilePath = null;
      insertionLine = -1;
      settings.lastActiveFile = null;
    }
    saveSettings();
    return buildStatePayload();
  });

  ipcMain.handle('create-file', (_event, payload) => {
    // Legacy support or new multi-root payload
    const fileName = typeof payload === 'string' ? payload : payload.fileName;
    const targetFolder = typeof payload === 'string' ? settings.workingFolders[0] : payload.targetFolder;

    if (!targetFolder) return { error: 'No folder selected' };
    const safeName = fileName.replace(/[^a-zA-Z0-9_\-\.\s]/g, '').replace(/^\.+/, '').trim();
    if (!safeName) return { error: 'Invalid file name' };
    // Windows reserves device names — creating "CON.md" fails or misbehaves
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safeName)) {
      return { error: 'That name is reserved by Windows. Pick another' };
    }

    const filePath = path.join(targetFolder, safeName + '.md');
    if (fs.existsSync(filePath)) return { error: 'File already exists' };

    try {
      fs.writeFileSync(filePath, `# ${safeName}\n`);
    } catch (e) {
      return { error: 'Could not create the note: ' + e.message };
    }
    activeFilePath = filePath;
    insertionLine = 0; // Point to the heading line
    settings.lastActiveFile = activeFilePath;
    saveSettings();

    return buildStatePayload();
  });

  ipcMain.handle('set-active-file', (_event, filePath) => {
    if (fs.existsSync(filePath)) {
      activeFilePath = filePath;
      insertionLine = -1;
      settings.lastActiveFile = activeFilePath;
      saveSettings();
      return buildStatePayload();
    }
    return { error: 'File not found' };
  });

  ipcMain.handle('set-insertion-line', (_event, line) => {
    insertionLine = line;
    console.log('[Casrion] Insertion point set to line:', line);
    return { insertionLine };
  });

  ipcMain.handle('get-note-content', () => {
    let content = activeFilePath ? readFileContent(activeFilePath) : '';
    return hydrateContentForRenderer(content, activeFilePath);
  });

  // Quick note popup (fire-and-forget events from the popup window)
  ipcMain.on('quick-input-submit', (_event, payload) => {
    const { text, mode, keepOpen } = payload || {};
    // Ctrl+Enter keeps the popup open so a heading, some text, and a quote
    // can be added one after another without reopening it each time.
    if (!keepOpen && quickInputWindow && !quickInputWindow.isDestroyed()) quickInputWindow.hide();
    // Same ordered queue as hotkey captures so nothing interleaves mid-write
    enqueueCapture(() => insertTypedText(text, String(mode || 'text')));
  });
  ipcMain.on('quick-input-hide', () => {
    if (quickInputWindow && !quickInputWindow.isDestroyed()) quickInputWindow.hide();
  });
  ipcMain.on('help-overlay-hide', () => {
    if (helpOverlayWindow && !helpOverlayWindow.isDestroyed()) helpOverlayWindow.hide();
  });

  ipcMain.handle('set-stamp-source', (_event, enabled) => {
    setStampSource(enabled);
    return { stampSource: !!settings.stampSource };
  });

  ipcMain.handle('app-mark', () => {
    const mark = Buffer.from(APP_MARK, 'base64').toString('utf-8');
    showOverlayNotification(mark, 'text', 6000);
    return mark;
  });

  // The native minimize/maximize/close buttons are drawn by Windows, so they
  // must be recolored from here whenever the renderer switches theme.
  ipcMain.handle('set-titlebar-theme', (event, dark) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.setTitleBarOverlay(dark
        ? { color: '#1c1816', symbolColor: '#9a8f87', height: 40 }
        : { color: '#e6dbc5', symbolColor: '#5f5344', height: 40 });
    } catch { /* not supported on this platform */ }
  });

  ipcMain.handle('quit-app', () => {
    quitApp();
  });
}

// ─── App Lifecycle ─────────────────────────────────────────

// A second instance can't register the global shortcuts (they'd silently
// fail), so redirect it to the running one instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

const ASSET_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.pdf': 'application/pdf', '.txt': 'text/plain'
};

// Read an asset with retries. Freshly captured files are often briefly
// locked by antivirus/indexing services (EBUSY/EPERM) right when the
// renderer requests them — one failed read must not surface as a broken
// image. Whole-buffer reads also avoid mid-stream failures after the
// response headers have already been sent.
const fsp = fs.promises;
const MAX_BUFFERED_ASSET = 64 * 1024 * 1024;
async function readAssetWithRetry(filePath, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) { const e = new Error('not a file'); e.code = 'EISDIR'; throw e; }
      if (stat.size > MAX_BUFFERED_ASSET) return { stream: true, size: stat.size };
      const data = await fsp.readFile(filePath);
      return { data, size: data.length };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
  throw lastErr;
}

app.whenReady().then(() => {
  // A second instance is already quitting (lock check above) — it must not
  // race the real one for the tray, shortcuts and protocol registration.
  if (!gotSingleInstanceLock) return;

  // Ties the taskbar icon, notifications and pinning to our app identity
  // (without it Windows groups the app under a generic Electron identity).
  app.setAppUserModelId('com.casrion.app');

  protocol.handle('casrion', async (request) => {
    try {
      const u = new URL(request.url);
      // Windows paths carry a drive letter in the URL host ("casrion://c/Users/..."
      // → host "c", so rebuild "c:/Users/..."). macOS and Linux absolute paths
      // have an empty host ("casrion:///Users/..."), so the pathname is the path.
      const filePath = path.normalize(decodeURIComponent(
        u.host ? u.host + ':' + u.pathname : u.pathname
      ));

      // Only serve files that live inside a workspace folder — this scheme
      // must not be a read-anything-on-disk primitive for rendered HTML.
      const allowed = (settings.workingFolders || []).some(folder => {
        const rel = path.relative(folder, filePath);
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      });
      if (!allowed) {
        console.warn('[Casrion] Blocked casrion:// request outside workspace:', filePath);
        return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } });
      }

      const asset = await readAssetWithRetry(filePath);
      const mime = ASSET_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      // no-store: a response must never be cached, so one bad read can not
      // leave a player permanently broken across sessions.
      const baseHeaders = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      const size = asset.size;

      // Honor HTTP Range requests — Chromium's <audio>/<video> stack issues
      // them for media, and a plain 200-only response leaves players stuck
      // in a "disabled"/unseekable state on some machines.
      const rangeHeader = request.headers.get('Range');
      const match = rangeHeader && /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      if (match && (match[1] !== '' || match[2] !== '')) {
        let start, end;
        if (match[1] === '') {
          // Suffix range: last N bytes
          start = Math.max(0, size - parseInt(match[2], 10));
          end = size - 1;
        } else {
          start = parseInt(match[1], 10);
          end = match[2] === '' ? size - 1 : Math.min(parseInt(match[2], 10), size - 1);
        }
        if (start > end || start >= size) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' } });
        }
        const rangeHeaders = {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1)
        };
        const body = asset.data
          ? asset.data.subarray(start, end + 1)
          : Readable.toWeb(fs.createReadStream(filePath, { start, end }));
        return new Response(body, { status: 206, headers: rangeHeaders });
      }

      const body = asset.data ? asset.data : Readable.toWeb(fs.createReadStream(filePath));
      return new Response(body, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(size) }
      });
    } catch (e) {
      console.error('[Casrion] Failed to serve asset:', request.url, e.message);
      // no-store here too — a cached 404 outlives the transient file lock
      // that caused it and replays the failure on every later load attempt.
      return new Response('File not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
  });

  loadSettings();

  if (settings.lastActiveFile && fs.existsSync(settings.lastActiveFile)) {
    activeFilePath = settings.lastActiveFile;
  }

  // Warm up the source-title helper if the user left stamping enabled, and
  // send one throwaway request so PowerShell compiles its UI Automation
  // types now instead of during the first real capture. Deferred a few
  // seconds: spawning PowerShell during launch competes with the window's
  // first paint on slower machines, and a capture that beats the timer
  // starts the helper on demand anyway.
  if (settings.stampSource && process.platform === 'win32') {
    setTimeout(() => {
      if (settings.stampSource) {
        startTitleHelper();
        getForegroundSourceInfo(5000);
      }
    }, 3500);
  }

  createWindow();
  createOverlayWindow();
  createTray();
  registerShortcuts();
  registerIPC();

  explainFeature.init({
    // wantUrl:false — explain never needs the browser URL, and on macOS the
    // URL lookup would spawn osascript and trigger a browser Automation prompt
    getForegroundSourceInfo: (timeoutMs) => getForegroundSourceInfo(timeoutMs, true, false),
    cleanSourceTitle,
    showOverlayNotification,
    enqueueCapture,
    insertTypedText,
    getActiveFilePath: () => activeFilePath,
    getSettings: () => settings,
    saveSettings
  });

  // The quick-note window exists so its hotkey opens instantly, but a window
  // is a whole renderer process (~35MB), so only the ones worth that much get
  // built ahead of time, and never on the launch critical path. The help panel
  // is deliberately not one of them: it is read once and then never again, and
  // toggleHelpOverlay already builds it on demand.
  const warmSecondaryWindows = () => {
    if (!quickInputWindow || quickInputWindow.isDestroyed()) createQuickInputWindow();
    // Starts the selection watcher so the hotkey works on text selected before
    // its first use. The explain popup, its OCR helper and the model are not
    // built here: they cost ~1.9GB between them and now wait for a sign the
    // user actually wants them.
    explainFeature.warmUp();
  };
  watchMacFrontApp();
  mainWindow.once('show', () => setTimeout(warmSecondaryWindows, 1500));
  setTimeout(warmSecondaryWindows, 6000); // fallback if the window stays hidden

  // Dock-icon click on macOS: the hidden helper windows mean getAllWindows()
  // is never empty, so rebuild/show the main window explicitly instead.
  app.on('activate', () => showMainWindow());
});

app.on('window-all-closed', () => { /* Keep running in tray */ });

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopTitleHelper();
  explainFeature.shutdown();
});
