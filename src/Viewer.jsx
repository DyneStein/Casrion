import { useRef, useEffect, useMemo, useState, Component, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { ChevronRight, List, X, Link2 } from 'lucide-react';

// Source stamps are stored in the note as `<sub>Source: title · time</sub>`
// lines (older notes may carry a paperclip emoji variant). They are not
// rendered as text — they become right-click metadata on the blocks below.
const STAMP_RE = /^<sub[^>]*>\s*(?:Source:\s*|📎\s*)?([\s\S]*?)<\/sub>\s*$/;

// Lines Casrion writes itself: a screenshot, a source stamp, a voice memo.
// None of them can legitimately sit inside a captured code block, so one of
// these is where an unterminated fence has to stop.
const APP_WRITTEN_RE = /^(!\[|<sub[\s>]|<audio[\s>])/;

/**
 * One malformed block (broken raw HTML, hostile TeX, etc.) must never blank
 * the whole document — render that block as plain text and keep going.
 */
class BlockBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { console.error('[Casrion] Block render failed:', err); }
  // No reset logic needed: blocks are keyed by their content, so edited
  // text mounts a fresh boundary automatically.
  render() {
    if (this.state.failed) {
      return <pre className="doc-block-fallback">{this.props.text}</pre>;
    }
    return this.props.children;
  }
}

const ASSET_RETRIES = 5;
const retryDelay = (attempt) => 350 * Math.pow(2, attempt - 1); // 350ms → 5.6s

/**
 * Image that heals itself. A freshly captured screenshot can fail its very
 * first load (antivirus briefly locks the new file); since blocks keep
 * stable keys across updates, a broken <img> would otherwise stay broken
 * until the app restarts. On error we reload with a cache-busting query.
 */
// Whiteboards are saved as board-N.svg in the note's assets folder, so they
// arrive here as ordinary markdown images and only need recognising.
const BOARD_RE = /\/assets\/board-\d+\.svg$/i;

function AssetImage({ node: _node, src, ...props }) {
  const [attempt, setAttempt] = useState(0);
  const [reload, setReload] = useState(0);
  const attemptRef = useRef(0);
  const timerRef = useRef(null);

  useEffect(() => {
    // New source — start fresh
    attemptRef.current = 0;
    setAttempt(0);
    return () => clearTimeout(timerRef.current);
  }, [src]);

  const isLocal = typeof src === 'string' && src.startsWith('casrion://');
  const isBoard = isLocal && BOARD_RE.test(src.split('?')[0]);
  const url = isLocal && (attempt > 0 || reload > 0)
    ? `${src}${src.includes('?') ? '&' : '?'}v=${attempt}.${reload}`
    : src;

  // Saving over a board leaves the note's text identical, so nothing would
  // re-render it. Bump the URL to pull the new file in.
  useEffect(() => {
    if (!isBoard) return;
    const clean = src.split('?')[0];
    const onSaved = (e) => {
      const rel = String(e.detail?.relPath || '').replace(/\\/g, '/');
      if (rel && clean.endsWith('/' + rel)) setReload((n) => n + 1);
    };
    window.addEventListener('casrion-board-saved', onSaved);
    return () => window.removeEventListener('casrion-board-saved', onSaved);
  }, [isBoard, src]);

  const handleError = () => {
    if (!isLocal || attemptRef.current >= ASSET_RETRIES) return;
    attemptRef.current += 1;
    const next = attemptRef.current;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setAttempt(next), retryDelay(next));
  };

  // The board is drawn in its own floating window, so this only has to say
  // which file to pick back up.
  const openBoard = () => {
    const clean = src.split('?')[0];
    const at = clean.lastIndexOf('/assets/');
    if (at === -1) return;
    window.electronAPI?.openBoard?.(decodeURIComponent(clean.slice(at + 1)));
  };

  // lazy + async: a long note full of screenshots only decodes what is on
  // screen, which keeps scrolling smooth and memory flat on weaker machines.
  return (
    <img
      {...props}
      src={url}
      onError={handleError}
      alt={props.alt ?? ''}
      loading="lazy"
      decoding="async"
      className={isBoard ? 'board-img' : undefined}
      title={isBoard ? 'Whiteboard. Double-click to draw on it again' : props.title}
      onDoubleClick={isBoard ? openBoard : undefined}
    />
  );
}

/**
 * Audio player for voice memos.
 *
 * Recordings made by Casrion now carry their real length in the file, so the
 * player knows the duration the moment it reads the header. Memos recorded
 * before that (and anything else live-muxed) report a duration of Infinity,
 * and the only way to resolve it is the old trick of seeking far past the end
 * and letting the browser discover where the audio really stops.
 *
 * That trick is a loaded gun. On a file that is not fully in memory the seek
 * becomes a read past the end of the file, Chromium calls that a fatal
 * pipeline error, and the player is dead for good — greyed out controls, no
 * playback, no recovery. So it only fires once the whole file is buffered and
 * the duration is genuinely missing, and if it does break something the
 * player reloads without it: a memo that plays but shows no length is a small
 * annoyance, a memo that refuses to play at all is a lost recording.
 *
 * Failed loads self-heal like images do: retries swap in a cache-busted URL,
 * because Chromium pins the failure to the original URL for a while — a
 * plain load() (or even unmount/remount on the same src) replays the cached
 * error and the player looks permanently dead. The retry budget resets on
 * every successful load so one bad stretch (antivirus briefly locking a
 * fresh recording) can never disable the player for the rest of the session,
 * and clicking a dead player retries immediately.
 */
const AUDIO_RETRIES = 8;
function AudioNote({ node: _node, src, ...props }) {
  const audioRef = useRef(null);
  const [attempt, setAttempt] = useState(0);
  const attemptRef = useRef(0);
  const timerRef = useRef(null);
  // { armed } — whether the duration trick may still be tried on this file,
  // { pending } — a trick seek is in flight, so blame it for any error now
  const seekFixRef = useRef({ armed: true, pending: false });

  useEffect(() => {
    // New source — start fresh
    attemptRef.current = 0;
    seekFixRef.current = { armed: true, pending: false };
    setAttempt(0);
  }, [src]);

  const isLocal = typeof src === 'string' && src.startsWith('casrion://');
  const url = isLocal && attempt > 0 ? `${src}${src.includes('?') ? '&' : '?'}retry=${attempt}` : src;

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const fix = seekFixRef.current;

    const durationUnknown = () => el.duration === Infinity || Number.isNaN(el.duration);
    // HAVE_ENOUGH_DATA, one buffered range starting at zero, and Chromium no
    // longer fetching (NETWORK_IDLE): the local file is in memory, so a seek
    // is answered from there instead of becoming a read off the end of it.
    const fullyBuffered = () => el.readyState >= 4 && el.networkState === 1
      && el.buffered.length === 1 && el.buffered.start(0) === 0;

    const tryFixDuration = () => {
      if (!fix.armed || fix.pending || !durationUnknown() || !fullyBuffered()) return;
      fix.armed = false; // one attempt per file, ever
      fix.pending = true;
      const settle = () => {
        fix.pending = false;
        el.removeEventListener('seeked', rewind);
        clearTimeout(fix.timer);
      };
      const rewind = () => {
        try { el.currentTime = 0; } catch { /* nothing to rewind yet */ }
        settle();
      };
      el.addEventListener('seeked', rewind);
      fix.timer = setTimeout(settle, 3000); // seek never landed: stop blaming it
      try { el.currentTime = 1e101; } catch { settle(); }
    };

    const handleLoaded = () => {
      attemptRef.current = 0;
      tryFixDuration();
    };
    const reload = (delay) => {
      attemptRef.current += 1;
      const next = attemptRef.current;
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setAttempt(next), delay);
    };
    const handleError = () => {
      if (!isLocal) return;
      if (fix.pending) {
        // The duration trick did this to itself. Reload at once without it,
        // and skip the backoff: nothing is actually wrong with the file, and
        // the successful reload clears the retry count again anyway.
        fix.pending = false;
        fix.armed = false;
        reload(80);
        return;
      }
      if (attemptRef.current >= AUDIO_RETRIES) return;
      reload(Math.min(retryDelay(attemptRef.current + 1), 8000));
    };

    el.addEventListener('loadedmetadata', handleLoaded);
    el.addEventListener('canplaythrough', tryFixDuration);
    el.addEventListener('suspend', tryFixDuration);
    el.addEventListener('error', handleError);
    return () => {
      clearTimeout(timerRef.current);
      clearTimeout(fix.timer);
      el.removeEventListener('loadedmetadata', handleLoaded);
      el.removeEventListener('canplaythrough', tryFixDuration);
      el.removeEventListener('suspend', tryFixDuration);
      el.removeEventListener('error', handleError);
    };
  }, [url, isLocal]);

  // A click anywhere on a dead player revives it on the spot — users mash
  // the play button when it looks stuck, so make that gesture the fix.
  const handleClick = () => {
    const el = audioRef.current;
    if (!el || !el.error || !isLocal) return;
    clearTimeout(timerRef.current);
    attemptRef.current += 1;
    setAttempt(attemptRef.current);
  };

  // Local recordings preload fully: they are small, and a whole-file buffer
  // is what lets an index-less webm compute its duration and seek instantly.
  // Remote/other sources keep the lighter metadata preload.
  return <audio {...props} src={url} ref={audioRef} controls preload={isLocal ? 'auto' : 'metadata'} onClick={handleClick} />;
}

// Stable plugin references so the memoized block renderer's props never
// change identity between renders.
const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeRaw, rehypeKatex];
const MD_COMPONENTS = { audio: AudioNote, img: AssetImage };
const passUrl = (url) => url;

/**
 * Markdown for one block, memoized on its text. Long notes re-render on
 * every capture; without this every block re-parses its markdown each time,
 * which adds up fast on lower-end machines. With it, only changed blocks pay.
 */
const BlockMarkdown = memo(function BlockMarkdown({ text }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      urlTransform={passUrl}
      components={MD_COMPONENTS}
    >{text}</ReactMarkdown>
  );
});

// Source strings are stored HTML-escaped inside the stamp; undo that for
// display and split out any web address so it can be a clickable link.
function unescapeEntities(s) {
  return (s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function SourceText({ source }) {
  const text = unescapeEntities(source);
  const parts = text.split(/(https?:\/\/\S+)/);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part)
          ? <a key={i} href={part} className="source-link">{part}</a>
          : <span key={i}>{part}</span>
      )}
    </>
  );
}

/**
 * Groups raw lines into semantic "blocks" for proper markdown rendering.
 * Each block contains one or more consecutive lines that form a single
 * markdown element (paragraph, heading, list, code fence, etc.)
 */
function parseBlocks(content) {
  if (!content) return [];

  const lines = content.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Code fence block ────────────────────────
    if (line.trimStart().startsWith('```')) {
      // A fence with no partner used to run to the end of the file, and
      // everything under it rendered as literal text: screenshots turned
      // back into their own paths, math into raw TeX, for the rest of the
      // note. One stray ``` (an explain answer cut off mid-block, half a
      // code sample copied off a page) was enough to do it.
      //
      // So look for the closing fence, but stop looking at the first line
      // the app itself wrote. A screenshot, a source stamp or a voice memo
      // is never inside a captured code block, so one appearing first means
      // this fence was never closed, and the safe reading is to treat the
      // marker as ordinary text and keep parsing. A fence that simply runs
      // to the end of the file with nothing structural below still becomes
      // a code block, which is what markdown says and costs nothing.
      let close = -1;
      let boundary = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trimStart().startsWith('```')) { close = j; break; }
        if (APP_WRITTEN_RE.test(lines[j].trimStart())) { boundary = j; break; }
      }
      if (close === -1 && boundary !== -1) {
        blocks.push({ type: 'paragraph', text: line, startLine: i, endLine: i });
        i++;
        continue;
      }
      const endLine = close === -1 ? lines.length - 1 : close;
      blocks.push({ type: 'code', text: lines.slice(i, endLine + 1).join('\n'), startLine: i, endLine });
      i = endLine + 1;
      continue;
    }

    // ── Source stamp (hidden metadata line) ─────
    const stampMatch = STAMP_RE.exec(line.trim());
    if (stampMatch) {
      blocks.push({ type: 'stamp', text: line, startLine: i, endLine: i, stampSource: stampMatch[1].trim() });
      i++;
      continue;
    }

    // A stamp with text glued onto the same line (captures made before the
    // append fix): split it so the stamp hides and the text still shows.
    const glued = /^(<sub[^>]*>\s*(?:Source:\s*|📎\s*)?([\s\S]*?)<\/sub>)\s*(\S[\s\S]*)$/.exec(line.trim());
    if (glued) {
      blocks.push({ type: 'stamp', text: glued[1], startLine: i, endLine: i, stampSource: glued[2].trim() });
      blocks.push({ type: 'paragraph', text: glued[3], startLine: i, endLine: i });
      i++;
      continue;
    }

    // ── Heading ─────────────────────────────────
    if (/^#{1,6}\s/.test(line)) {
      blocks.push({ type: 'heading', text: line, startLine: i, endLine: i });
      i++;
      continue;
    }

    // ── Image ───────────────────────────────────
    if (line.trimStart().startsWith('![')) {
      blocks.push({ type: 'image', text: line, startLine: i, endLine: i });
      i++;
      continue;
    }

    // ── Blockquote (consecutive > lines) ────────
    if (line.startsWith('> ') || line === '>') {
      const startLine = i;
      const blockLines = [line];
      i++;
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        blockLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'quote', text: blockLines.join('\n'), startLine, endLine: i - 1 });
      continue;
    }

    // ── List (consecutive - or * lines) ─────────
    if (/^[\s]*[-*]\s/.test(line) || /^[\s]*\d+\.\s/.test(line)) {
      const startLine = i;
      const blockLines = [line];
      i++;
      while (i < lines.length && (/^[\s]*[-*]\s/.test(lines[i]) || /^[\s]*\d+\.\s/.test(lines[i]) || (lines[i].startsWith('  ') && lines[i].trim() !== ''))) {
        blockLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'list', text: blockLines.join('\n'), startLine, endLine: i - 1 });
      continue;
    }

    // ── Blank line ──────────────────────────────
    if (line.trim() === '') {
      blocks.push({ type: 'blank', text: '', startLine: i, endLine: i });
      i++;
      continue;
    }

    // ── Paragraph (consecutive non-empty text) ──
    {
      const startLine = i;
      const blockLines = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^#{1,6}\s/.test(lines[i]) &&
        !lines[i].trimStart().startsWith('![') &&
        !lines[i].trimStart().startsWith('```') &&
        !lines[i].startsWith('> ') &&
        !/^[\s]*[-*]\s/.test(lines[i]) &&
        !/^[\s]*\d+\.\s/.test(lines[i]) &&
        !STAMP_RE.test(lines[i].trim())
      ) {
        blockLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'paragraph', text: blockLines.join('\n'), startLine, endLine: i - 1 });
    }
  }

  return blocks;
}

function Viewer({ content, insertionLine, onSetInsertionLine }) {
  const viewerRef = useRef(null);
  const activeBlockRef = useRef(null);
  const [showOutline, setShowOutline] = useState(() => localStorage.getItem('casrion_outline') !== 'off');
  const [sourcePopover, setSourcePopover] = useState(null); // { x, y, source }

  // The source popover dismisses on any click, scroll or Escape
  useEffect(() => {
    if (!sourcePopover) return;
    const close = () => setSourcePopover(null);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [sourcePopover]);

  const showSource = (e, source) => {
    e.preventDefault();
    e.stopPropagation();
    setSourcePopover({
      x: Math.min(e.clientX, window.innerWidth - 340),
      y: Math.min(e.clientY, window.innerHeight - 90),
      source
    });
  };

  const toggleOutline = () => {
    setShowOutline((prev) => {
      localStorage.setItem('casrion_outline', prev ? 'off' : 'on');
      return !prev;
    });
  };

  const jumpToLine = (line) => {
    const el = viewerRef.current?.querySelector(`[data-line="${line}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Scroll to active block smoothly
  useEffect(() => {
    if (activeBlockRef.current) {
      activeBlockRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [insertionLine, content]);

  // Key blocks by their own content, not their index — with index keys,
  // inserting a capture above an <audio> block remounts the player and cuts
  // off playback. Content-derived keys keep untouched blocks mounted.
  const blocks = useMemo(() => {
    const parsed = parseBlocks(content);
    const seen = new Map();
    // A stamp applies to everything below it until the next stamp
    let currentSource = null;
    for (const block of parsed) {
      if (block.type === 'stamp') {
        currentSource = block.stampSource || null;
      } else if (block.type !== 'blank') {
        block.source = currentSource;
      }
      const base = `${block.type}:${block.text.length}:${block.text.slice(0, 80)}`;
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      block.key = `${base}#${n}`;
    }
    return parsed;
  }, [content]);

  // Auto table-of-contents from the note's headings
  const outline = useMemo(() => blocks
    .filter((b) => b.type === 'heading')
    .map((b) => {
      const m = /^(#{1,6})\s+(.*)$/.exec(b.text);
      return {
        level: m ? m[1].length : 1,
        label: (m ? m[2] : b.text).replace(/[*_`#]/g, '').trim(),
        line: b.startLine,
        key: b.key
      };
    }), [blocks]);

  if (!content) {
    return (
      <div className="viewer-empty">
        <h2>No file selected</h2>
        <p>Select a file from the sidebar, or create a new note to get started.</p>
        <p className="shortcut-hint">The shortcuts you will reach for most:</p>
        <div className="shortcut-grid">
          <div className="shortcut-card">
            <div className="shortcut-keys"><span className="kbd">Ctrl</span><span className="kbd-plus">+</span><span className="kbd">Shift</span><span className="kbd-plus">+</span><span className="kbd">C</span></div>
            <div className="shortcut-label">Append copied text</div>
          </div>
          <div className="shortcut-card">
            <div className="shortcut-keys"><span className="kbd">Ctrl</span><span className="kbd-plus">+</span><span className="kbd">Shift</span><span className="kbd-plus">+</span><span className="kbd">Q</span></div>
            <div className="shortcut-label">Type a quick note</div>
          </div>
          <div className="shortcut-card">
            <div className="shortcut-keys"><span className="kbd">Ctrl</span><span className="kbd-plus">+</span><span className="kbd">Shift</span><span className="kbd-plus">+</span><span className="kbd">V</span></div>
            <div className="shortcut-label">Paste image</div>
          </div>
          <div className="shortcut-card">
            <div className="shortcut-keys"><span className="kbd">Ctrl</span><span className="kbd-plus">+</span><span className="kbd">Shift</span><span className="kbd-plus">+</span><span className="kbd">M</span></div>
            <div className="shortcut-label">Voice memo</div>
          </div>
          <div className="shortcut-card">
            <div className="shortcut-keys"><span className="kbd">Ctrl</span><span className="kbd-plus">+</span><span className="kbd">Shift</span><span className="kbd-plus">+</span><span className="kbd">H</span></div>
            <div className="shortcut-label">All shortcuts</div>
          </div>
        </div>
      </div>
    );
  }

  // Check if a block contains the active insertion line
  const isBlockActive = (block) => {
    if (insertionLine === -1) return false;
    return insertionLine >= block.startLine && insertionLine <= block.endLine;
  };

  const isAppendEnd = insertionLine === -1;

  return (
    <div className="viewer" ref={viewerRef}>
      {outline.length >= 2 && !showOutline && (
        <button className="outline-toggle" onClick={toggleOutline} title="Show outline">
          <List size={16} strokeWidth={1.5} />
        </button>
      )}
      {outline.length >= 2 && showOutline && (
        <nav className="outline-panel">
          <div className="outline-header">
            <span>Outline</span>
            <button className="outline-close" onClick={toggleOutline} title="Hide outline">
              <X size={14} strokeWidth={1.5} />
            </button>
          </div>
          <div className="outline-items">
            {outline.map((h) => (
              <button
                key={h.key}
                className={`outline-item outline-level-${Math.min(h.level, 3)}`}
                onClick={() => jumpToLine(h.line)}
                title={h.label}
              >
                {h.label}
              </button>
            ))}
          </div>
        </nav>
      )}
      <div className="document-body">
        {blocks.map((block) => {
          const active = isBlockActive(block);

          // Stamps carry metadata only; the blocks below them show it
          if (block.type === 'stamp') return null;

          if (block.type === 'blank') {
            return (
              <div
                key={block.key}
                data-line={block.startLine}
                className={`doc-block doc-block-blank ${active ? 'doc-block-active' : ''}`}
                onClick={() => onSetInsertionLine(block.endLine)}
                ref={active ? activeBlockRef : null}
              />
            );
          }

          return (
            <div
              key={block.key}
              data-line={block.startLine}
              className={`doc-block doc-block-${block.type} ${active ? 'doc-block-active' : ''} ${block.source ? 'doc-block-sourced' : ''}`}
              onClick={() => onSetInsertionLine(block.endLine)}
              onContextMenu={block.source ? (e) => showSource(e, block.source) : undefined}
              ref={active ? activeBlockRef : null}
            >
              {active && (
                <div className="active-indicator">
                  <ChevronRight size={14} strokeWidth={1.5} />
                </div>
              )}
              {block.source && (
                <button
                  className="source-marker"
                  title={`Source: ${block.source}. Click for details`}
                  onClick={(e) => showSource(e, block.source)}
                >
                  <Link2 size={12} strokeWidth={1.5} />
                </button>
              )}
              <div className="doc-block-content">
                <BlockBoundary text={block.text}>
                  <BlockMarkdown text={block.text} />
                </BlockBoundary>
              </div>
            </div>
          );
        })}

        {/* Append-at-end zone */}
        <div
          className={`doc-block doc-block-end ${isAppendEnd ? 'doc-block-active' : ''}`}
          onClick={() => onSetInsertionLine(-1)}
          ref={isAppendEnd ? activeBlockRef : null}
        >
          <span className="end-label">End of document. New content is added here</span>
        </div>
      </div>

      {sourcePopover && (
        <div className="source-popover" style={{ left: sourcePopover.x, top: sourcePopover.y }}>
          <div className="source-popover-title">Captured from</div>
          <div className="source-popover-text"><SourceText source={sourcePopover.source} /></div>
        </div>
      )}
    </div>
  );
}

export default Viewer;
