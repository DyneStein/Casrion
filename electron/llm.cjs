// Local model engine for the explain feature. Wraps node-llama-cpp:
// downloads the GGUF on first use (not bundled, it would 10x the installer),
// keeps the model warm between requests, and streams tokens out.
// node-llama-cpp is ESM-only, so everything goes through one dynamic import.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Qwen3-1.7B at Q4_K_M: small enough for weak laptops, good at short plain
// explanations, Apache licensed, and the repo is not gated so the download
// needs no account. Size is pinned so a truncated download can't pass.
const MODEL_URL = 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf';
const MODEL_FILE = 'Qwen3-1.7B-Q4_K_M.gguf';
const MODEL_SIZE = 1107409472;
const MODEL_LABEL = 'Qwen3 1.7B (about 1.1 GB)';

// Qwen3 is a hybrid thinking model; left alone it burns seconds "thinking"
// before the first visible word. /no_think plus a zero thought budget plus
// filtering thought segments keeps every generated token user-visible.
// Length and depth are requested per prompt (quick vs detailed), keeping
// this prefix identical across requests so its tokens stay cached.
const SYSTEM_PROMPT = [
  'You explain things to the reader in simple everyday English, like a sharp',
  'friend leaning over their shoulder. You get a term, context from their',
  'screen, and an instruction for how long the answer should be. Keep every',
  'sentence easy: short common words, and any technical word gets explained',
  'right away. Use the context to tie the explanation to what they are',
  'reading, but never talk about the context itself: never say "the',
  'selection", "the text", "the page", "this refers to", "is mentioned", or',
  'describe the window, app or document. Start directly with the thing itself',
  'as the subject, like "Chlorophyll is the green pigment that...". If it is',
  'a formula, walk through what it means and what each symbol stands for.',
  'Never copy the given text back word for word; always explain in your own',
  'words. No preamble, no headings, no bullet lists. /no_think'
].join(' ');

// A loaded model is ~1.8GB resident, far and away the biggest thing this app
// holds, so it does not get to linger. Coming back is not free: measured on a
// warm file cache it is ~9s to push the weights over Vulkan plus ~2s to build
// the context, so every unload buys back 1.8GB at the price of one ~11s "warming
// up" wait on the next question. Each answer bumps this timer, so a reading
// session stays instant throughout and only a real gap in use pays that cost.
const IDLE_UNLOAD_MS = 5 * 60 * 1000;

let state = 'idle'; // idle | downloading | loading | ready | generating | error
let lastError = null;
let nlcImport = null;      // cached import('node-llama-cpp') promise
let llama = null;
let model = null;
let context = null;
let session = null;
let loadPromise = null;
let downloadAbort = null;
let generateAbort = null;
let idleTimer = null;

function modelDir() { return path.join(app.getPath('userData'), 'models'); }
function modelPath() { return path.join(modelDir(), MODEL_FILE); }

function hasModelFile() {
  try { return fs.statSync(modelPath()).size === MODEL_SIZE; } catch { return false; }
}

function getState() {
  return { state, error: lastError, modelLabel: MODEL_LABEL, hasModel: hasModelFile() };
}

function bumpIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { unload().catch(() => {}); }, IDLE_UNLOAD_MS);
}

// ── Download ────────────────────────────────────────────────

async function downloadModel(onProgress) {
  if (state === 'downloading') return;
  fs.mkdirSync(modelDir(), { recursive: true });
  const finalPath = modelPath();
  const partPath = finalPath + '.part';
  state = 'downloading';
  lastError = null;
  downloadAbort = new AbortController();
  try {
    let start = 0;
    try { start = fs.statSync(partPath).size; } catch { /* fresh download */ }
    if (start > MODEL_SIZE) { fs.rmSync(partPath, { force: true }); start = 0; }

    if (start < MODEL_SIZE) {
      const res = await fetch(MODEL_URL, {
        headers: start > 0 ? { Range: `bytes=${start}-` } : {},
        signal: downloadAbort.signal
      });
      if (res.status === 200) start = 0; // server ignored the range, start over
      else if (res.status !== 206) throw new Error(`download failed (HTTP ${res.status})`);

      const out = fs.createWriteStream(partPath, { flags: start > 0 ? 'a' : 'w' });
      let received = start;
      let lastTick = 0;
      try {
        for await (const chunk of res.body) {
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
          received += chunk.length;
          const now = Date.now();
          if (onProgress && now - lastTick > 250) {
            lastTick = now;
            onProgress({ received, total: MODEL_SIZE, pct: Math.floor((received / MODEL_SIZE) * 100) });
          }
        }
      } finally {
        await new Promise((r) => out.end(r));
      }
    }

    const got = fs.statSync(partPath).size;
    if (got !== MODEL_SIZE) throw new Error(`download incomplete (${got} of ${MODEL_SIZE} bytes)`);
    fs.renameSync(partPath, finalPath);
    state = 'idle';
    if (onProgress) onProgress({ received: MODEL_SIZE, total: MODEL_SIZE, pct: 100 });
  } catch (e) {
    // The .part file stays on disk so the next attempt resumes where it stopped
    state = 'error';
    lastError = e.name === 'AbortError' ? 'download paused' : e.message;
    throw e;
  } finally {
    downloadAbort = null;
  }
}

function cancelDownload() {
  if (downloadAbort) downloadAbort.abort();
}

// ── Load / unload ───────────────────────────────────────────

async function ensureLoaded(onStatus) {
  if (session) { bumpIdleTimer(); return; }
  if (loadPromise) return loadPromise;
  if (!hasModelFile()) throw new Error('model not downloaded');
  loadPromise = (async () => {
    state = 'loading';
    if (onStatus) onStatus('loading');
    try {
      if (!nlcImport) nlcImport = import('node-llama-cpp');
      const { getLlama, LlamaChatSession } = await nlcImport;
      // build:'never' keeps user machines on the shipped prebuilt binaries;
      // getLlama picks Vulkan when the GPU cooperates and CPU otherwise.
      if (!llama) llama = await getLlama({ build: 'never' });
      model = await llama.loadModel({ modelPath: modelPath() });
      context = await model.createContext({ contextSize: 2048 });
      session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt: SYSTEM_PROMPT
      });
      state = 'ready';
      lastError = null;
      bumpIdleTimer();
    } catch (e) {
      state = 'error';
      lastError = e.message;
      await unload().catch(() => {});
      throw e;
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

async function unload() {
  clearTimeout(idleTimer);
  const m = model, c = context;
  session = null; context = null; model = null;
  if (state !== 'error') state = 'idle';
  try { if (c) await c.dispose(); } catch { /* already gone */ }
  try { if (m) await m.dispose(); } catch { /* already gone */ }
}

// ── Generation ──────────────────────────────────────────────

let activeGeneration = null;
let genQueue = Promise.resolve();
let latestTicket = 0;

// Absorb the one-time costs (weight page-in, first-generation buffer and
// shader setup) in the background so the first real question streams in
// ~2s instead of ~25s. The weights are mmapped, so an unused warm model
// costs little: the OS evicts its pages whenever memory gets tight.
async function prewarm() {
  if (!hasModelFile() || state === 'generating' || activeGeneration || session) return;
  await explain({ prompt: 'ready', maxTokens: 2 });
}

// Generations run strictly one at a time on the shared session. A newer
// request aborts whatever is running, and requests that got superseded
// while still waiting in the queue never start at all — rapid quick/detail
// toggling or hotkey spam can't interleave two answers.
async function explain({ prompt, onChunk, onStatus, maxTokens = 320 }) {
  const ticket = ++latestTicket;
  if (generateAbort) generateAbort.abort();
  const run = genQueue.then(async () => {
    if (ticket !== latestTicket) return '';
    await ensureLoaded(onStatus);
    if (ticket !== latestTicket) return '';
    if (onStatus) onStatus('thinking');
    state = 'generating';
    generateAbort = new AbortController();
    const myAbort = generateAbort;
    try {
      // Fresh history per request, but the same context sequence: the system
      // prompt tokens stay cached, so prefill only pays for the new question
      session.setChatHistory([{ type: 'system', text: SYSTEM_PROMPT }]);
      activeGeneration = session.prompt(prompt, {
        maxTokens,
        temperature: 0.3,
        signal: myAbort.signal,
        stopOnAbortSignal: true, // return what was generated instead of throwing
        budgets: { thoughtTokens: 0 },
        onResponseChunk(chunk) {
          // Never surface chain-of-thought segments, only the actual answer
          if (chunk.type === 'segment' && chunk.segmentType === 'thought') return;
          if (chunk.text && onChunk) onChunk(chunk.text);
        }
      });
      return await activeGeneration;
    } finally {
      activeGeneration = null;
      if (generateAbort === myAbort) generateAbort = null;
      if (state === 'generating') state = session ? 'ready' : 'idle';
      bumpIdleTimer();
    }
  });
  genQueue = run.then(() => {}, () => {});
  return run;
}

function abortActive() {
  if (generateAbort) generateAbort.abort();
}

async function shutdown() {
  cancelDownload();
  abortActive();
  await unload().catch(() => {});
}

module.exports = {
  MODEL_LABEL,
  getState,
  hasModelFile,
  downloadModel,
  cancelDownload,
  ensureLoaded,
  prewarm,
  explain,
  abortActive,
  shutdown
};
