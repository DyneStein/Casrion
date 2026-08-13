// Explain anywhere: select text in any app, hit Ctrl+Shift+E (Cmd+Shift+E on
// macOS), and a small popup near the selection explains it in plain language
// using the local model. Selection text and coordinates come from the
// selection-hook native addon (UI Automation), page context comes from the
// title helper plus a quick OCR of the pixels around the selection.
//
// There used to be a second way in: tapping the bare modifier key twice. It is
// gone on purpose. The gesture needed the global keyboard tap, which on macOS
// means Input Monitoring, a permission most people never granted, and when it
// is missing the gesture fails silently: no popup, no error, nothing to tell
// you which of the two permissions you were missing. The chord needs no
// permission at all because Electron registers it with the window server, so
// it works the moment the app starts. One way in that always works beats two
// where the nicer one usually does not.
const path = require('path');
const { BrowserWindow, screen, ipcMain, systemPreferences } = require('electron');
const llm = require('./llm.cjs');
const ocr = require('./ocr.cjs');

const IS_MAC = process.platform === 'darwin';
const INVALID_COORD = -99999;

// The selection hook's clipboard fallback is OFF everywhere, and must stay off.
// When a native accessibility read finds nothing, that fallback empties the
// user's real clipboard, fires a simulated Ctrl+C at the foreground app, waits
// up to ~280ms, then puts back a copy of what it saved. Two things go wrong:
// anything it could not copy (a screenshot the snipping tool published by
// delayed rendering, for one) is simply gone, and even when the restore works
// the clipboard sits empty for a few hundred milliseconds. In an app whose
// whole job is capturing what you copied, that is unacceptable: it is what made
// screenshots vanish before Ctrl+Shift+V could paste them. On macOS it was also
// dishonest, silently returning stale clipboard text as if it were a fresh
// selection. Explain reads selections through UI Automation / AXAPI only.
/**
 * Passive mode is the difference between Casrion being invisible and Casrion
 * making the whole machine feel slow.
 *
 * Left off (which is the library's default), the hook answers every drag
 * selection and every double click by reading the selected text through UI
 * Automation on Windows and the Accessibility API on macOS. Both are
 * synchronous cross-process calls, and crucially both are served by the UI
 * thread of the app being read. So finishing a selection in Chrome hands
 * Chrome a job, and the Ctrl+C the user presses a moment later has to queue
 * behind it. That is the two second copy: nothing to do with the copy, and
 * everything to do with us interrogating the app at the exact moment the user
 * was about to talk to it. It also runs on our own main thread, so the same
 * read stalls Casrion.
 *
 * Giving it up costs nothing, because nothing in here wants a selection until
 * the user asks for one. triggerExplain reads it on demand through
 * getCurrentSelection(). One read when somebody presses the shortcut, instead
 * of one read every time anybody selects any text in any application, forever.
 *
 * Do not turn this off to "fix" a missed selection. Fix the on-demand read.
 */
const HOOK_START_OPTS = { enableClipboard: false, selectionPassiveMode: true };
const WIN_W = 470;
const WIN_H = 190;

let deps = null;            // injected by main.cjs, no circular require
let hook = null;
let hookFailed = false;
let lastEventSelection = null; // freshest 'text-selection' event, hotkey fallback
let explainWindow = null;
let currentRun = 0;         // stale async results check against this
let lastShownText = '';     // so re-pressing the hotkey on the same selection toggles
let lastSelForRerun = null; // lets the quick/detailed toggle re-answer in place
let lastCapture = null;     // context reused on reruns: the popup covers the
                            // page by then, so a fresh OCR would read itself

function init(d) {
  deps = d;
  ipcMain.on('explain-hide', () => hideExplain());
  ipcMain.on('explain-download', () => startModelDownload());
  // From the popup's own footer, when it has noticed clicking away does nothing
  ipcMain.on('explain-fix-click-away', () => {
    if (!IS_MAC) return;
    require('electron').shell
      .openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent')
      .catch(() => {});
    hideExplain();
  });
  ipcMain.on('explain-mode', (_event, payload) => {
    const settings = deps.getSettings();
    settings.explainDetail = !!(payload && payload.detail);
    deps.saveSettings();
    // Re-answer the same selection in the new mode right away
    if (lastSelForRerun && explainWindow && !explainWindow.isDestroyed() && explainWindow.isVisible()) {
      beginRun(lastSelForRerun);
    }
  });
  ipcMain.on('explain-resize', (_event, height) => {
    if (!explainWindow || explainWindow.isDestroyed()) return;
    const b = explainWindow.getBounds();
    const h = Math.max(150, Math.min(440, Math.round(height)));
    if (h === b.height) return;
    // Growing while streaming must never push the popup off screen: nudge
    // it back inside the work area of whatever display it is on
    const wa = screen.getDisplayMatching(b).workArea;
    const x = Math.min(Math.max(b.x, wa.x + 8), wa.x + wa.width - b.width - 8);
    let y = b.y;
    if (y + h > wa.y + wa.height - 8) y = Math.max(wa.y + 8, wa.y + wa.height - h - 8);
    explainWindow.setBounds({ x, y, width: b.width, height: h });
  });
  ipcMain.on('explain-save-note', (_event, payload) => {
    const { selection, answer } = payload || {};
    if (!answer) return;
    if (!deps.getActiveFilePath()) {
      deps.showOverlayNotification('Open a note first to save explanations', 'text');
      return;
    }
    const head = String(selection || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const body = String(answer).trim().replace(/\n/g, '\n> ');
    const md = `> **${head}**\n>\n> ${body}`;
    deps.enqueueCapture(() => deps.insertTypedText(md, 'text'));
    deps.showOverlayNotification('Explanation saved', 'text');
  });
}

function isEnabled() {
  return deps.getSettings().explainEnabled !== false;
}

function setEnabled(enabled) {
  const settings = deps.getSettings();
  settings.explainEnabled = !!enabled;
  deps.saveSettings();
  if (enabled) {
    initSelectionHook();
  } else {
    hideExplain();
    if (hook) { try { hook.stop(); } catch { /* already stopped */ } }
  }
}

// ── selection-hook ──────────────────────────────────────────

let axPrompted = false;   // macOS: prompted for Accessibility once this run
let macTrusted = false;   // macOS: Accessibility granted (selection + keys work)
let sawHookMouse = false; // the global mouse hook has delivered at least one click
let workspaceSub = null;  // macOS: NSWorkspace app-activation subscription
let shownCount = 0;       // how many times the popup has been put on screen

/**
 * Clicking away is supposed to close the popup, and on macOS it quietly did
 * not. The only thing listening for that click is the global mouse hook, and
 * the hook's event taps need Input Monitoring, which is a different permission
 * from the Accessibility one that makes the rest of the feature work. Grant one
 * and not the other and explaining works perfectly while the answer refuses to
 * go away.
 *
 * So macOS gets a second way out that needs no permission at all: AppKit tells
 * any app when a different app is brought to the front, which is what clicking
 * on another window does. It only listens while the popup is actually up.
 */
function watchAppSwitch(on) {
  if (!IS_MAC) return;
  try {
    if (on && workspaceSub === null) {
      workspaceSub = systemPreferences.subscribeWorkspaceNotification(
        'NSWorkspaceDidActivateApplicationNotification',
        () => {
          // Clicking the popup to copy an answer out of it activates Casrion
          // too, and that is the opposite of clicking away. Let focus settle
          // for a frame, then only close if the popup did not get it.
          setTimeout(() => {
            if (!explainWindow || explainWindow.isDestroyed() || !explainWindow.isVisible()) return;
            if (explainWindow.isFocused()) return;
            hideExplain();
          }, 60);
        }
      );
    } else if (!on && workspaceSub !== null) {
      systemPreferences.unsubscribeWorkspaceNotification(workspaceSub);
      workspaceSub = null;
    }
  } catch {
    // Older macOS, or the notification name changed out from under us. The
    // hook is still there, so this is a fallback losing a fallback.
    workspaceSub = null;
  }
}

// True when we can be reasonably sure the click-away hook is dead: macOS only,
// and only once the user has had the popup up long enough to have clicked
// something. Used to explain the missing permission where the symptom is.
function macClickAwayLikelyBlocked() {
  return IS_MAC && !sawHookMouse && shownCount >= 2;
}

// On macOS the hook starts fine without Accessibility permission, but it reads
// no selection and fires no key/mouse events until the user grants it. The
// per-call AXAPI selection read starts working the instant permission is
// granted; the global key/mouse taps only re-arm when the hook is restarted,
// so re-establish them here the moment we notice the grant landed.
function refreshMacTrust(promptIfNeeded) {
  if (!IS_MAC || !hook) return;
  let nowTrusted = false;
  try { nowTrusted = hook.macIsProcessTrusted(); } catch { nowTrusted = false; }
  if (nowTrusted && !macTrusted) {
    try { hook.stop(); hook.start(HOOK_START_OPTS); } catch { /* a restart will re-arm */ }
  }
  macTrusted = nowTrusted;
  // Only surface the system prompt on a real user trigger, never at startup:
  // it opens System Settings, which is jarring the moment the app launches.
  if (!macTrusted && promptIfNeeded && !axPrompted) {
    axPrompted = true;
    try { systemPreferences.isTrustedAccessibilityClient(true); } catch { /* hook still starts */ }
  }
}

function macNeedsAccessibility() {
  return IS_MAC && !macTrusted;
}

function initSelectionHook(promptForTrust) {
  if (!isEnabled() || (process.platform !== 'win32' && !IS_MAC)) return;
  if (hook) {
    try { if (!hook.isRunning()) hook.start(HOOK_START_OPTS); } catch { /* keep old state */ }
    refreshMacTrust(promptForTrust);
    return;
  }
  if (hookFailed) return;
  try {
    const SelectionHook = require('selection-hook');
    hook = new SelectionHook();
    // Silent under passive mode, and kept only as a backstop for
    // getSelectionNow in case passive mode is ever turned off again. Nothing
    // expensive belongs in here: it runs for every selection on the machine.
    hook.on('text-selection', (data) => {
      if (data && data.text && data.text.trim()) {
        lastEventSelection = { data, ts: Date.now() };
      }
    });
    // The popup opens without stealing focus, so blur can't dismiss it.
    // The global mouse hook stands in: any click outside its bounds hides it.
    hook.on('mouse-down', (e) => {
      // On macOS this whole handler is silent until Input Monitoring is
      // granted, which is what makes clicking away appear to do nothing.
      // Remembering that we have seen one is how we can tell the difference
      // between "not granted" and "granted but you have not clicked yet".
      sawHookMouse = true;
      if (!explainWindow || explainWindow.isDestroyed() || !explainWindow.isVisible()) return;
      if (e.x === INVALID_COORD || e.y === INVALID_COORD) return;
      const p = toDip({ x: e.x, y: e.y });
      const b = explainWindow.getBounds();
      if (p.x < b.x || p.x > b.x + b.width || p.y < b.y || p.y > b.y + b.height) {
        hideExplain();
      }
    });
    // No key-down/key-up subscription any more. The only thing that ever
    // listened was the double-tap gesture, and prewarming hung off the same
    // signal. Both are gone, so nothing here reads your keystrokes.
    hook.on('error', (err) => console.error('[Casrion] selection-hook:', err && err.message));
    hook.on('status', (s) => console.log('[Casrion] selection-hook status:', s));
    const ok = hook.start(HOOK_START_OPTS);
    if (!ok) {
      console.error('[Casrion] selection-hook failed to start');
      hookFailed = true;
      hook = null;
      return;
    }
    // Start succeeds even on macOS without permission; check trust (prompting
    // only when this init came from a real user trigger, not startup warm-up).
    refreshMacTrust(promptForTrust);
  } catch (e) {
    console.error('[Casrion] selection-hook unavailable:', e.message);
    hookFailed = true;
    hook = null;
  }
}

function getSelectionNow() {
  let sel = null;
  if (hook) {
    try { sel = hook.getCurrentSelection(); } catch { sel = null; }
  }
  if (sel && sel.text && sel.text.trim()) return sel;
  // Under passive mode this is normally empty, because the event that fills it
  // is exactly the one that was stalling every copy (see HOOK_START_OPTS). It
  // stays as a backstop for the non-passive configuration rather than as the
  // path anything relies on.
  if (lastEventSelection && Date.now() - lastEventSelection.ts < 15000) {
    return lastEventSelection.data;
  }
  return null;
}

/**
 * The first read of an app is allowed to fail, so ask twice.
 *
 * Chromium browsers and Electron apps do not publish an accessibility tree
 * until somebody asks them to, by setting AXEnhancedUserInterface (Chromium)
 * or AXManualAccessibility (Electron) on the application element. selection-hook
 * does set both, but only after its own read has already failed, and it then
 * returns that failure without trying again (selection_hook.mm, end of
 * GetTextViaAXAPI: the comment says "final try" and no retry follows it). The
 * tree it just switched on is not read until the next call.
 *
 * So the first press of the shortcut at a given app is guaranteed to come back
 * empty, and the popup says nothing is selected while pointing at a paragraph
 * that plainly is. Asking a second time, once the tree exists, is the whole fix.
 *
 * Deliberately not a blocking wait: this runs in the shortcut handler, and
 * parking the main thread here would stall the popup it is about to open.
 * The cost is only ever paid on a read that already failed.
 */
const AX_WAKE_MS = 140;
function getSelectionSoon(done) {
  const first = getSelectionNow();
  if (first || !IS_MAC) { done(first); return; }
  setTimeout(() => done(getSelectionNow()), AX_WAKE_MS);
}

// ── window ──────────────────────────────────────────────────

function toDip(point) {
  // selection-hook returns physical pixels on Windows (convert to DIP) but
  // already-logical points on macOS (converting again would halve them on a
  // Retina screen and throw the popup into the top-left corner).
  if (IS_MAC) return point;
  try { return screen.screenToDipPoint(point); } catch { return point; }
}

function createExplainWindow() {
  explainWindow = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    transparent: true,
    // Stops macOS flashing the frameless window solid black before paint
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
  explainWindow.setAlwaysOnTop(true, 'screen-saver');
  // macOS pins screen-saver-level windows to one Space and hides them behind
  // fullscreen apps; float over all Spaces so the popup lands where the user is
  if (IS_MAC) {
    try { explainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* older macOS */ }
  }
  explainWindow.loadFile(path.join(__dirname, 'explain-overlay.html'));
  // Shown inactive, so this only fires after the user clicked into the
  // popup (to copy text) and then clicked away
  explainWindow.on('blur', () => {
    if (explainWindow && !explainWindow.isDestroyed() && explainWindow.isVisible()) hideExplain();
  });
}

function warmUp() {
  if (!isEnabled()) return;
  // Only the selection watcher starts eagerly: it is cheap, and the hotkey has
  // to know what was selected before its first use. The popup window, the OCR
  // helper and the model were all being warmed on a launch timer whether or not
  // the user ever asked for anything, which came to ~1.9GB and dwarfed the
  // whole rest of the app. They start on the first real question instead.
  initSelectionHook();
  warnIfUpdateDroppedPermission();
}

/**
 * Every Casrion update silently revokes Accessibility, and macOS does not say so.
 *
 * There is no Apple Developer certificate, so the app is signed ad-hoc and its
 * Designated Requirement is the cdhash of that exact binary:
 *
 *   codesign -d -r- /Applications/Casrion.app
 *   # designated => cdhash H"62b121..."
 *
 * TCC stores that requirement next to the grant. A new build has a new cdhash,
 * so the stored requirement stops matching a binary at the same path with the
 * same bundle id, and the grant quietly stops applying. Measured directly: the
 * same machine reported trusted for 1.0.2 and not trusted for 1.0.3 within
 * minutes, with nobody touching System Settings in between.
 *
 * What makes it worse than a permission you never granted is that System
 * Settings keeps showing Casrion in the list with the switch still on, so the
 * one place anybody would look says everything is fine. Toggling that switch
 * does not help either: it rewrites the answer, not the requirement the answer
 * was recorded against. Only removing the row and adding the app back does.
 *
 * So the app has to notice on its own. Once per version, and only when an
 * earlier version really did run here, which keeps a fresh install (where
 * nothing has been granted yet, and the popup already explains that) quiet.
 */
function warnIfUpdateDroppedPermission() {
  if (!IS_MAC || !deps) return;
  let version = '';
  try { version = require('electron').app.getVersion(); } catch { return; }
  const settings = deps.getSettings();
  const seen = settings.lastVersionSeen;
  if (seen !== version) {
    settings.lastVersionSeen = version;
    deps.saveSettings();
  }
  // A first run on this machine has nothing to have lost.
  if (!seen || seen === version) return;
  // Give the hook a moment: refreshMacTrust runs inside initSelectionHook, and
  // a grant that survived would report by now.
  setTimeout(() => {
    if (!hook || !macNeedsAccessibility()) return;
    // The toast is one line with an ellipsis past ~600px, so this has to stay
    // short. The full instructions live in the explain popup, which is where
    // somebody lands the moment they try to use the thing that broke.
    deps.showOverlayNotification('Update dropped Casrion from Accessibility. Grant it again', 'error', 6000);
  }, 4000);
}

// There is no prewarming any more. It only ever had one trigger, a bare tap of
// the modifier key, and that went with the double-tap gesture. Every remaining
// candidate signal is either useless (the chord itself, which arrives at the
// same moment as the work it would be racing) or unacceptable (prewarming on
// any click anywhere, which is what the mouse hook sees).
//
// So the first question of a session pays for the window, the OCR helper and
// the model load, and every question after it finds them up. That cost was
// already being paid by anyone whose tap had not fired first, which on macOS
// was anyone without Input Monitoring: most people.

function markExplainUsed() {
  const settings = deps.getSettings();
  if (settings.explainUsed) return;
  settings.explainUsed = true;
  deps.saveSettings();
}

function validPoint(p) {
  return p && p.x !== INVALID_COORD && p.y !== INVALID_COORD && !(p.x === 0 && p.y === 0);
}

function positionWindow(sel) {
  // Anchor under the end of the selection; physical px from the hook
  // become DIPs before touching Electron's coordinate space
  let anchor = null;
  if (sel) {
    for (const p of [sel.endBottom, sel.mousePosEnd, sel.startBottom]) {
      if (validPoint(p)) { anchor = toDip(p); break; }
    }
  }
  if (!anchor) anchor = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(anchor).workArea;
  const b = explainWindow.getBounds();
  // Clamp against the height the popup will likely grow to while the
  // answer streams in, not its collapsed starting height
  const grownH = 320;
  let x = Math.round(anchor.x - 40);
  let y = Math.round(anchor.y + 14);
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - b.width - 8));
  if (y + grownH > wa.y + wa.height - 8) {
    // No room below the selection, open above it instead
    let top = anchor.y;
    if (sel && validPoint(sel.startTop)) top = toDip(sel.startTop).y;
    y = Math.max(wa.y + 8, Math.round(top - grownH - 12));
  }
  explainWindow.setBounds({ x, y, width: b.width, height: b.height });
}

function send(channel, payload) {
  if (explainWindow && !explainWindow.isDestroyed()) {
    explainWindow.webContents.send(channel, payload);
  }
}

function hideExplain() {
  currentRun++;
  llm.abortActive();
  lastShownText = '';
  lastSelForRerun = null;
  lastCapture = null;
  if (explainWindow && !explainWindow.isDestroyed() && explainWindow.isVisible()) {
    explainWindow.hide();
  }
  watchAppSwitch(false);
}

// ── the hotkey flow ─────────────────────────────────────────

function triggerExplain() {
  if (!deps || !isEnabled()) return;
  initSelectionHook(true); // a real trigger may prompt for macOS Accessibility
  // Toggling closed must stay instant, and it does not need the selection to
  // be right: pressing the shortcut again while the popup is up means close it.
  // Only a read that came back empty waits, and only on macOS.
  const visible = explainWindow && !explainWindow.isDestroyed() && explainWindow.isVisible();
  getSelectionSoon((sel) => {
    // Same selection (or none) while open means "close it"
    if (visible && (!sel || sel.text.trim() === lastShownText)) {
      hideExplain();
      return;
    }

    if (!explainWindow || explainWindow.isDestroyed()) {
      createExplainWindow();
      explainWindow.webContents.once('did-finish-load', () => beginRun(sel));
      return;
    }
    beginRun(sel);
  });
}

function beginRun(sel) {
  const runId = ++currentRun;
  llm.abortActive();
  positionWindow(sel);
  const selText = sel ? sel.text.replace(/\s+/g, ' ').trim() : '';
  lastShownText = selText;
  lastSelForRerun = selText ? sel : null;
  send('explain-context', {
    selection: selText,
    app: sel ? prettyAppName(sel.programName) : '',
    detail: deps.getSettings().explainDetail === true,
    modelLabel: llm.MODEL_LABEL,
    // Say so in the popup itself, which is the one place the user is looking
    // when they wonder why it will not go away.
    clickAwayBlocked: macClickAwayLikelyBlocked()
  });

  const showNow = () => {
    // Keep the user's app focused: their selection stays highlighted and
    // they can keep reading while the answer streams in
    if (explainWindow && !explainWindow.isDestroyed() && !explainWindow.isVisible()) {
      shownCount++;
      explainWindow.showInactive();
      watchAppSwitch(true);
    }
  };

  if (!selText) {
    showNow();
    // On macOS an empty read usually means Accessibility was never granted,
    // not that nothing is selected; guide the user instead of misleading them.
    if (macNeedsAccessibility()) {
      send('explain-status', { state: 'need-permission' });
      return;
    }
    send('explain-status', { state: 'no-selection' });
    // Name the app the read actually went to. "Nothing selected" on its own is
    // a dead end, because it cannot distinguish an app that keeps its selection
    // private from a read that was pointed at the wrong app entirely. If this
    // comes back naming Casrion, or the login window, that is the second bug
    // and not the first. Only runs when the read already failed, so it costs
    // nothing on the path that works.
    if (IS_MAC && deps.getForegroundSourceInfo) {
      Promise.resolve(deps.getForegroundSourceInfo(800))
        .then((info) => {
          if (runId !== currentRun) return;
          if (info && info.app) send('explain-status', { state: 'no-selection', app: info.app });
        })
        .catch(() => { /* the plain message stands */ });
    }
    return;
  }
  if (!llm.hasModelFile()) {
    showNow();
    send('explain-status', { state: 'need-model', modelLabel: llm.MODEL_LABEL });
    return;
  }
  // A real question is about to run, so future sessions may prewarm on a tap
  markExplainUsed();

  // Context is captured once per selection, BEFORE the popup paints: the
  // OCR screenshots the pixels around the selection, and the popup sits
  // right there. Reruns (quick/detail toggle) reuse the clean capture.
  if (!lastCapture || lastCapture.selText !== selText) {
    lastCapture = {
      selText,
      srcPromise: deps.getForegroundSourceInfo(1200).catch(() => null),
      ocrPromise: captureNearbyText(sel, selText).catch(() => '')
    };
    // ~90ms gives the OCR helper time to grab its screenshot popup-free
    setTimeout(() => { if (runId === currentRun) showNow(); }, 90);
  } else {
    showNow();
  }

  runExplain(runId, sel, selText, lastCapture).catch((e) => {
    if (runId !== currentRun) return;
    console.error('[Casrion] explain failed:', e.message);
    send('explain-status', { state: 'error', message: friendlyError(e) });
  });
}

async function runExplain(runId, sel, selText, capture) {
  // Everything slow runs in parallel and the prompt takes whatever made it
  // back in time; a missing piece of context never blocks the answer
  const warmPromise = llm.ensureLoaded((s) => {
    if (runId === currentRun) send('explain-status', { state: s === 'loading' ? 'warming' : s });
  });

  const [src, nearby] = await Promise.all([capture.srcPromise, capture.ocrPromise]);
  if (runId !== currentRun) return;
  await warmPromise;
  if (runId !== currentRun) return;

  const detail = deps.getSettings().explainDetail === true;
  const prompt = buildPrompt(sel, selText, src, nearby, detail);
  console.log('[Casrion] explain context:', JSON.stringify({
    app: sel.programName, detail, title: (src && src.title) || '', url: (src && src.url) || '', nearbyChars: nearby.length
  }));
  let streamed = false;
  const answer = await llm.explain({
    prompt,
    maxTokens: detail ? 320 : 110,
    onStatus: () => { if (runId === currentRun) send('explain-status', { state: 'thinking' }); },
    onChunk: (text) => {
      if (runId !== currentRun) return;
      // The model warms up with a blank line or two; swallowing them keeps
      // the popup from opening with an empty gap above the answer
      if (!streamed) {
        text = text.replace(/^\s+/, '');
        if (!text) return;
        streamed = true;
        send('explain-status', { state: 'streaming' });
      }
      send('explain-chunk', text);
    }
  });
  if (runId !== currentRun) return;
  send('explain-done', { answer: tidyAnswer(answer) });

  // Single-word selections get a bonus line: the word's plain dictionary
  // meaning, separate from what it means on this page
  const word = singleWord(selText);
  if (!word) return;
  let litStreamed = false;
  const literal = await llm.explain({
    prompt: `In one short sentence, give the literal general meaning of the word "${word}", like a tiny dictionary entry. If it is not a real dictionary word, say in a few words what it appears to be (a name, a brand, an abbreviation). Do not mention any page or context. Do not repeat the word's contextual role.`,
    maxTokens: 60,
    onChunk: (text) => {
      if (runId !== currentRun) return;
      if (!litStreamed) {
        text = text.replace(/^\s+/, '');
        if (!text) return;
        litStreamed = true;
      }
      send('explain-literal-chunk', text);
    }
  });
  if (runId !== currentRun) return;
  send('explain-literal-done', { literal: tidyAnswer(literal) });
}

// A "single word" survives stray spaces and punctuation around it
function singleWord(t) {
  const w = String(t || '').trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!w || /\s/.test(w) || w.length > 30) return null;
  return w;
}

// A token-capped answer can stop mid-sentence; cut it back to the last
// complete sentence so it never trails off
function tidyAnswer(text) {
  const t = String(text || '').trim();
  if (!t || /[.!?…)"']$/.test(t)) return t;
  const m = t.match(/^[\s\S]*[.!?…](?=[\s")\]]|$)/);
  return m ? m[0].trim() : t;
}

async function captureNearbyText(sel, selText) {
  if (!sel) return '';
  // Physical pixels straight from the hook; the OCR helper is DPI aware so
  // no conversion happens on this path
  const pts = [sel.startTop, sel.startBottom, sel.endTop, sel.endBottom, sel.mousePosEnd].filter(validPoint);
  if (!pts.length) return '';
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const w = 1100, h = 640;
  const text = await ocr.ocrRegion(cx - w / 2, cy - h / 2, w, h, 900);
  if (!text) return '';
  return ocr.trimNearest(text, selText, 170);
}

function prettyAppName(name) {
  if (!name) return '';
  const base = String(name).replace(/\.exe$/i, '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function buildPrompt(sel, selText, src, nearby, detail) {
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '...' : s);
  const lines = [];
  // Small models respect the edges of the prompt most, so the length rule
  // goes first AND last
  if (!detail) lines.push('Answer in at most 2 short sentences.');
  // The app name (chrome, brave...) stays out of the prompt on purpose: it
  // grounds nothing and the model happily hallucinates browser features
  // around it. Title, site and nearby text are the real signals.
  const where = [];
  const title = src && src.title ? (deps.cleanSourceTitle(src.title) || '') : '';
  if (title) where.push(`a page titled "${clip(title, 120)}"`);
  if (src && src.url) {
    try { where.push(`on ${new URL(src.url).hostname}`); } catch { /* address bar had a search, not a URL */ }
  }
  if (where.length) lines.push('Context, for grounding only, never mention it: reading ' + where.join(', '));
  if (nearby) lines.push(`On-screen text nearby, also just for grounding: "${clip(nearby, 1200)}"`);
  // A whole sentence or paragraph needs unpacking, not defining; without
  // this the model happily hands the passage right back as the "answer"
  const isPassage = selText.length > 90 || selText.split(/\s+/).length > 12;
  lines.push(`${isPassage ? 'Passage' : 'Term'} to explain: "${clip(selText, 500)}"`);
  if (isPassage) {
    lines.push(detail
      ? 'Unpack this passage in your own words in 4 to 6 short sentences: what is it saying, what do the technical parts mean, and why does it matter here? Do not repeat the passage word for word.'
      : 'Say in AT MOST 2 short simple sentences, in your own words, what this passage means. Do not repeat it word for word. Stop after 2 sentences.');
  } else {
    lines.push(detail
      ? 'Explain it in one solid paragraph of 4 to 6 short sentences: what it is, the details that matter here, and a quick example or comparison if it helps. Simple English, specific to what this page is about, without referring to the page or the selection.'
      : 'Explain it in AT MOST 2 short simple sentences, hard limit: just the heart of what it is and what it means here, without referring to the page or the selection. Stop after 2 sentences.');
  }
  return lines.join('\n');
}

function friendlyError(e) {
  const msg = String((e && e.message) || e);
  if (/memory|alloc/i.test(msg)) return 'Not enough free memory to run the model. Close a few apps and try again.';
  return 'The explainer hit a snag: ' + msg;
}

// ── model download (driven from the popup) ──────────────────

let downloading = false;
async function startModelDownload() {
  if (downloading || llm.hasModelFile()) return;
  downloading = true;
  try {
    await llm.downloadModel((p) => send('explain-status', { state: 'downloading', pct: p.pct }));
    send('explain-status', { state: 'downloaded' });
    // Warm it right away so the first real question streams instantly
    llm.ensureLoaded().catch(() => { /* surfaces on first use instead */ });
  } catch (e) {
    send('explain-status', { state: 'error', message: 'Download did not finish: ' + e.message + '. It resumes from where it stopped.', retryDownload: true });
  } finally {
    downloading = false;
  }
}

// ── lifecycle ───────────────────────────────────────────────

function shutdown() {
  currentRun++;
  try { if (hook) { hook.stop(); hook.cleanup(); } } catch { /* exiting anyway */ }
  hook = null;
  ocr.stopOcrHelper();
  llm.shutdown().catch(() => {});
  if (explainWindow && !explainWindow.isDestroyed()) explainWindow.destroy();
  explainWindow = null;
}

// The name of the app that owns the current (or a very recent) selection.
// Source stamping on macOS reuses this: the selection hook already holds the
// Accessibility permission, so no separate automation prompt is needed. macOS
// may report a bundle id or path, so it is trimmed to a friendly name.
function getForegroundAppName() {
  if (!hook) return '';
  let raw = '';
  try {
    const s = hook.getCurrentSelection();
    if (s && s.programName) raw = s.programName;
  } catch { /* ignore */ }
  if (!raw && lastEventSelection && Date.now() - lastEventSelection.ts < 20000) {
    raw = lastEventSelection.data.programName || '';
  }
  let n = String(raw || '').trim();
  if (!n) return '';
  if (n.includes('/')) n = n.split('/').pop();      // a path -> basename
  n = n.replace(/\.app$/i, '');                      // "Safari.app" -> "Safari"
  if (/^[a-z]{2,}(\.[a-z0-9-]+){2,}$/i.test(n)) n = n.split('.').pop(); // com.apple.Safari -> Safari
  return n;
}

// Diagnostics for troubleshooting selection capture on a given machine
function debugState() {
  let current = null;
  try { current = hook ? hook.getCurrentSelection() : null; } catch (e) { current = 'EXC:' + e.message; }
  return {
    hookRunning: !!(hook && hook.isRunning()),
    hookFailed,
    macTrusted: IS_MAC ? macTrusted : undefined,
    lastEvent: lastEventSelection
      ? { text: lastEventSelection.data.text.slice(0, 80), ageMs: Date.now() - lastEventSelection.ts, program: lastEventSelection.data.programName }
      : null,
    current: current && typeof current === 'object'
      ? { text: (current.text || '').slice(0, 80), program: current.programName, method: current.method }
      : current
  };
}

module.exports = { init, warmUp, triggerExplain, setEnabled, isEnabled, shutdown, debugState, getForegroundAppName };
