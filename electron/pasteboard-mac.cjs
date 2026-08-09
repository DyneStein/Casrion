// The macOS pasteboard sequence number, made readable from inside a
// synchronous hotkey handler.
//
// Why this exists at all. Copying is not instant: the source app writes the
// pasteboard a beat after the key goes down, and pressing the capture hotkey
// in that gap reads the PREVIOUS copy. Measured on Safari with a rich text
// selection, the write landed 132ms after the capture had already read, so
// the wrong paragraph went into the note with a toast saying it worked.
//
// The old guard tried to spot this by comparing the text it read against the
// last text it captured. That cannot work in general, and the failure is the
// common case rather than an edge case: copy something and DON'T capture it,
// then copy something else and capture quickly, and the stale value matches
// nothing the guard knows about, so it never retries even once.
//
// macOS has the real answer. NSPasteboard.generalPasteboard.changeCount is a
// monotonic counter that the system bumps on every write by anyone. "Has a new
// copy landed since the last capture" stops being a guess and becomes a
// comparison of two integers. Windows has no equivalent, which is the only
// reason the text heuristic was ever written.
//
// Why a file and not stdio. Electron does not expose changeCount, so it has to
// come from a helper process. The obvious shape is the id-tagged stdio helper
// used for the Windows window title (see startTitleHelper in main.cjs), but
// that cannot work here: the capture path reads the clipboard synchronously
// inside the hotkey handler, and it parks the main thread with Atomics.wait
// between retries. A parked main thread cannot run the stdout handler, so a
// pushed value would never arrive during the exact wait that needs it. So the
// helper writes the counter to a small file instead, and the retry loop reads
// that file synchronously. A readFileSync of ten bytes costs well under a
// millisecond, which the loop can afford on every iteration.
//
// Everything here degrades to the old behaviour rather than breaking. If the
// helper fails to spawn, dies, or writes something unparseable, readSync
// returns null and the caller falls back to the text heuristic exactly as
// shipped in 1.0.1.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_MAC = process.platform === 'darwin';
const COUNT_FILE = path.join(os.tmpdir(), 'casrion-pbcount');

let helper = null;
let stopped = false;

// The helper polls in its own process, so none of this costs the main thread
// anything. It writes only when the value actually changes, so an idle machine
// does no work at all.
//
// The value is written as "C<n>\n". A torn read of a plain number would look
// like a smaller, perfectly valid number and would silently mean "no new copy",
// which is the exact bug being fixed. Requiring the marker and the newline
// makes a partial read fail the parse and fall back instead of lying.
const HELPER_JXA = `
ObjC.import('AppKit');
ObjC.import('Foundation');
var pb = $.NSPasteboard.generalPasteboard;
var target = ${JSON.stringify(COUNT_FILE)};
var last = -1;
while (true) {
  var c = pb.changeCount;
  if (c !== last) {
    last = c;
    try {
      $("C" + c + "\\n").writeToFileAtomicallyEncodingError(target, true, $.NSUTF8StringEncoding, null);
    } catch (e) { /* the reader falls back on its own */ }
  }
  $.NSThread.sleepForTimeInterval(0.005);
}
`;

function start() {
  if (!IS_MAC || helper || stopped) return;
  try {
    helper = spawn('osascript', ['-l', 'JavaScript', '-e', HELPER_JXA], {
      stdio: ['ignore', 'ignore', 'ignore']
    });
    helper.on('error', () => { helper = null; });
    helper.on('exit', () => {
      helper = null;
      // A crashed helper must not leave a frozen number behind: a stale file
      // would read as "the counter never moves", which makes every capture
      // look stale and wait out its whole budget. Removing it puts the caller
      // straight back on the 1.0.1 text heuristic.
      try { fs.unlinkSync(COUNT_FILE); } catch { /* already gone */ }
      if (!stopped) setTimeout(start, 2000);
    });
  } catch {
    helper = null;
  }
}

function stop() {
  stopped = true;
  if (helper) {
    try { helper.kill(); } catch { /* already gone */ }
    helper = null;
  }
  try { fs.unlinkSync(COUNT_FILE); } catch { /* already gone */ }
}

// Synchronous on purpose: this is called from inside the hotkey handler and
// from inside the retry loop that parks the main thread between attempts.
// Returns null whenever the answer cannot be trusted, never a guess.
function readSync() {
  if (!IS_MAC) return null;
  let raw;
  try {
    raw = fs.readFileSync(COUNT_FILE, 'utf8');
  } catch {
    return null;
  }
  if (raw.charCodeAt(0) !== 67 /* C */ || raw[raw.length - 1] !== '\n') return null;
  const n = Number(raw.slice(1, -1));
  return Number.isSafeInteger(n) ? n : null;
}

module.exports = { start, stop, readSync };
