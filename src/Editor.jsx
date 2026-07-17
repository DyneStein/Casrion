import { useEffect, useRef, useState } from 'react';
import { Bold, Italic, Heading1, Heading2, Heading3, AlignLeft, AlignCenter, AlignRight, List, ListOrdered, Table, Baseline, PaintBucket, Type, CornerDownLeft, ChevronUp, ChevronDown, X } from 'lucide-react';
import { marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// We don't use markedKatex here so that we can protect the raw LaTeX for editing
// marked.use(markedKatex({ throwOnError: false, nonStandard: true }));

// Marker options match what captures write ("- " bullets, *italic*), so an
// untouched note passes through an edit session without cosmetic rewrites.
const turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
turndownService.use(gfm);

// execCommand('justifyCenter') puts text-align on the paragraph or heading
// itself, not on a wrapper div — so this rule must match those elements too,
// or the alignment silently disappears on the next save.
turndownService.addRule('alignment', {
  filter: function(node) {
    if (!/^(DIV|P|H[1-6])$/.test(node.nodeName)) return false;
    const align = (node.getAttribute('align') || node.style.textAlign || '').toLowerCase();
    return align === 'center' || align === 'right' || align === 'justify' ||
      align === '-webkit-center' || align === '-webkit-right';
  },
  replacement: function(content, node) {
    let align = (node.getAttribute('align') || node.style.textAlign || '').toLowerCase();
    align = align.replace('-webkit-', '');
    let inner = content.trim();
    // A heading loses its own rule when this one claims the node — put the
    // markdown marker back so the roundtrip keeps the heading level.
    const h = /^H([1-6])$/.exec(node.nodeName);
    if (h) inner = '#'.repeat(Number(h[1])) + ' ' + inner;
    if (!inner) return '';
    return `\n\n<div align="${align}">\n\n${inner}\n\n</div>\n\n`;
  }
});

turndownService.addRule('audio', {
  filter: 'audio',
  replacement: function (content, node) {
    return `\n<audio controls src="${node.getAttribute('src')}"></audio>\n`;
  }
});

turndownService.addRule('spanStyles', {
  filter: function(node) { return node.nodeName === 'SPAN' || node.nodeName === 'FONT'; },
  replacement: function(content, node) {
    if (!content.trim()) return content;
    let size = node.getAttribute('size') || node.style.fontSize;
    if (size === '2') size = '0.8rem';
    if (size === '3') size = '1rem';
    if (size === '6') size = '1.5rem';
    let color = node.getAttribute('color') || node.style.color;
    if (color === '#334155' || color === 'rgb(51, 65, 85)' || color === 'inherit') color = null;
    if (!color && !size) return content;
    let style = '';
    if (color) style += `color: ${color}; `;
    if (size) style += `font-size: ${size}; `;
    return `<span style="${style.trim()}">${content}</span>`;
  }
});

turndownService.addRule('latexBlock', {
  filter: function (node) { return node.nodeName === 'PRE' && node.classList.contains('latex-block'); },
  replacement: function (content, node) { return '\n\n' + node.textContent + '\n\n'; }
});

turndownService.addRule('latexInline', {
  filter: function (node) { return node.nodeName === 'CODE' && node.classList.contains('latex-inline'); },
  replacement: function (content, node) { return node.textContent; }
});

// Atoms carry their original markdown in data-md and restore it verbatim, so
// the HTML round trip can never reshape a stamp or an audio tag. Added last:
// turndown checks the newest rule first, so this wins over the audio and
// alignment rules even if an atom also picks up e.g. a text-align style.
turndownService.addRule('mdAtom', {
  filter: function (node) {
    return node.nodeName === 'DIV' && node.getAttribute && node.getAttribute('data-md') !== null;
  },
  replacement: function (content, node) {
    let md = '';
    try { md = decodeURIComponent(node.getAttribute('data-md') || ''); } catch { md = ''; }
    return md ? '\n\n' + md + '\n\n' : '';
  }
});

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Source stamps are stored HTML-escaped; undo that for the chip label only.
const unescapeEntities = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Convert the parts of a note that must survive editing byte-for-byte into
 * non-editable "atoms" before marked parses the rest:
 * - source stamp lines (<sub>Source: ...</sub>) become labeled chips. Without
 *   this, turndown strips the <sub> tag and the stamp turns into visible
 *   plain text, losing the source linkage.
 * - <audio> tags become labeled chips. A live player inside an editable
 *   region is unreliable on some machines (controls stop responding and look
 *   permanently dead), so edit mode shows a solid placeholder instead and
 *   playback stays in the reading view. data-md restores the exact tag.
 * - $$...$$ blocks and inline $...$ stay raw for editing. The block pass runs
 *   on split segments so the inline pass can never match inside a block.
 */
function protectForEditor(md) {
  let content = String(md || '');

  // Stamp lines -> chips (whole line, so the viewer's stamp regex matches again on save)
  content = content.replace(/^[ \t]*<sub[^>]*>[\s\S]*?<\/sub>[ \t]*$/gm, (line) => {
    const m = /^<sub[^>]*>\s*(?:Source:\s*|📎\s*)?([\s\S]*?)<\/sub>\s*$/.exec(line.trim());
    const inner = m ? m[1].trim() : '';
    const title = unescapeEntities(inner).split(' · ')[0].trim();
    const label = inner
      ? `Source: ${escHtml(title)}`
      : 'Source boundary';
    const cls = inner ? 'md-atom stamp-atom' : 'md-atom stamp-atom stamp-atom-empty';
    return `<div class="${cls}" contenteditable="false" data-md="${encodeURIComponent(line)}" title="Source record. It moves and deletes as one piece and stays attached to the text below it">${label}</div>`;
  });

  // Voice memos -> labeled chips
  content = content.replace(/<audio\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/audio>/g, (tag, src) => {
    let name = String(src);
    try { name = decodeURIComponent(name); } catch { /* keep the raw path */ }
    name = name.split('/').pop() || 'recording';
    return `<div class="md-atom audio-atom" contenteditable="false" data-md="${encodeURIComponent(tag)}" title="Voice memo. Switch to the reading view to play it. It moves and deletes as one piece">Voice memo: ${escHtml(name)}</div>`;
  });

  // An atom div directly followed by content on the next line swallows that
  // content into its raw HTML block when marked parses it (lists there came
  // back as escaped plain text). Keep one blank line after every atom.
  if (content.includes('class="md-atom')) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].includes('class="md-atom') && lines[i + 1].trim() !== '') {
        lines.splice(i + 1, 0, '');
      }
    }
    content = lines.join('\n');
  }

  // LaTeX: protect $$blocks$$ on the odd split segments, inline $...$ on the rest
  const segments = content.split(/(\$\$[\s\S]+?\$\$)/);
  for (let i = 0; i < segments.length; i++) {
    if (i % 2 === 1) {
      segments[i] = `<pre class="latex-block">${escHtml(segments[i])}</pre>`;
    } else {
      segments[i] = segments[i].replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_m, before, body) =>
        `${before}<code class="latex-inline">$${escHtml(body)}$</code>`
      );
    }
  }
  return segments.join('');
}

function Editor({ content, onContentChange }) {
  const editorRef = useRef(null);
  const [activeStyles, setActiveStyles] = useState({});
  const [showTableMenu, setShowTableMenu] = useState(false);
  const [tableRows, setTableRows] = useState(3);
  const [tableCols, setTableCols] = useState(3);
  const [savedSelection, setSavedSelection] = useState(null);

  // ── Find in note (Ctrl+F) ──────────────────────────────
  // Matches are painted with the CSS Custom Highlight API, which never
  // touches the editable DOM — so searching can not dirty the document
  // or fight with the markdown round trip.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findState, setFindState] = useState({ total: 0, index: 0 });
  const findInputRef = useRef(null);
  const findRef = useRef({ open: false, query: '', index: 0 });
  findRef.current = { open: findOpen, query: findQuery, index: findState.index };

  const clearFindPaint = () => {
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.delete('casrion-find');
      CSS.highlights.delete('casrion-find-current');
    }
  };

  const runFind = (query, index) => {
    const el = editorRef.current;
    clearFindPaint();
    if (!el || !query || typeof CSS === 'undefined' || !CSS.highlights) {
      setFindState({ total: 0, index: 0 });
      return;
    }
    const q = query.toLowerCase();
    const ranges = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue.toLowerCase();
      let at = 0;
      while ((at = text.indexOf(q, at)) !== -1) {
        const range = new Range();
        range.setStart(node, at);
        range.setEnd(node, at + q.length);
        ranges.push(range);
        at += q.length;
      }
    }
    const total = ranges.length;
    const idx = total ? ((index % total) + total) % total : 0;
    setFindState({ total, index: idx });
    if (!total) return;
    CSS.highlights.set('casrion-find', new Highlight(...ranges));
    CSS.highlights.set('casrion-find-current', new Highlight(ranges[idx]));
    const anchor = ranges[idx].startContainer.parentElement;
    if (anchor) anchor.scrollIntoView({ block: 'center' });
  };

  const closeFind = () => {
    setFindOpen(false);
    setFindQuery('');
    setFindState({ total: 0, index: 0 });
    clearFindPaint();
    editorRef.current?.focus();
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setFindOpen(true);
        setTimeout(() => {
          findInputRef.current?.focus();
          findInputRef.current?.select();
        }, 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Leaving edit mode must never strand highlight paint
      if (typeof CSS !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete('casrion-find');
        CSS.highlights.delete('casrion-find-current');
      }
    };
  }, []);

  useEffect(() => {
    const el = editorRef.current;
    // Refresh the DOM from content unless the user is actively typing here.
    // document.activeElement alone is not enough: when the app window loses
    // OS focus (user copies from another app), activeElement still points at
    // the editor — but a background capture just changed the file, and keeping
    // the stale DOM would overwrite that capture on the next keystroke.
    const isActivelyEditing = document.hasFocus() &&
      (document.activeElement === el || document.activeElement?.className === 'table-creator-input');
    if (el && !isActivelyEditing) {
      el.innerHTML = marked.parse(protectForEditor(content)) + '<p class="trapped-cursor-fix"><br></p>';
    }
  }, [content]);

  // queryCommandState('justifyCenter') misses blocks aligned via the align
  // attribute or -webkit-* values, so read the computed style of the block
  // the caret sits in — that is what the user actually sees.
  const getSelectionAlignment = () => {
    const el = editorRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0) return 'left';
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!node || !el.contains(node)) return 'left';
    const ta = window.getComputedStyle(node).textAlign;
    if (ta.indexOf('center') !== -1) return 'center';
    if (ta.indexOf('right') !== -1) return 'right';
    return 'left';
  };

  const refreshActiveStyles = () => {
    const align = getSelectionAlignment();
    let block = '';
    try { block = String(document.queryCommandValue('formatBlock') || '').toLowerCase(); } catch { /* some selections have no block value */ }
    setActiveStyles({
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      h1: block === 'h1',
      h2: block === 'h2',
      h3: block === 'h3',
      left: align === 'left',
      center: align === 'center',
      right: align === 'right',
      ul: document.queryCommandState('insertUnorderedList'),
      ol: document.queryCommandState('insertOrderedList'),
    });
  };
  const refreshRef = useRef(refreshActiveStyles);
  refreshRef.current = refreshActiveStyles;

  useEffect(() => {
    const handleSelectionChange = () => {
      if (document.activeElement !== editorRef.current) return;
      refreshRef.current();
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, []);

  const handleInput = () => {
    const html = editorRef.current.innerHTML;
    const md = turndownService.turndown(html);
    onContentChange(md);
    // Typing moves text under the painted matches — repaint them
    if (findRef.current.open && findRef.current.query) {
      requestAnimationFrame(() => runFind(findRef.current.query, findRef.current.index));
    }
  };

  // Tab indents with four spaces (non-breaking, so markdown never mistakes
  // them for a code block and HTML never collapses them).
  const handleEditorKeyDown = (e) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '\u00A0\u00A0\u00A0\u00A0');
    }
  };

  // execCommand only works when the selection lives inside the editor. If a
  // toolbar click arrives before the user ever placed the caret, park it at
  // the end of the document instead of silently doing nothing.
  const ensureEditorSelection = () => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel.rangeCount || !el.contains(sel.getRangeAt(0).startContainer)) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };

  const formatDoc = (command, value = null) => {
    ensureEditorSelection();
    document.execCommand(command, false, value);
    handleInput();
    refreshActiveStyles();
  };

  const insertAlign = (alignment) => {
    ensureEditorSelection();
    if (alignment === 'center') document.execCommand('justifyCenter');
    else if (alignment === 'left') document.execCommand('justifyLeft');
    else if (alignment === 'right') document.execCommand('justifyRight');
    handleInput();
    refreshActiveStyles();
  };

  const forceNewLine = () => {
    const el = editorRef.current;
    if (!el) return;
    ensureEditorSelection();
    document.execCommand('insertHTML', false, '<p data-nl-target="1"><br></p>');
    // Move the caret INTO the fresh line, so typing continues there instead
    // of in whichever block the browser left the cursor after insertHTML.
    const target = el.querySelector('p[data-nl-target]');
    if (target) {
      target.removeAttribute('data-nl-target');
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(target, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    handleInput();
    refreshActiveStyles();
  };

  const handleOpenTableMenu = () => {
    if (!showTableMenu) {
      const sel = window.getSelection();
      if (sel.rangeCount > 0) {
        setSavedSelection(sel.getRangeAt(0));
      }
    }
    setShowTableMenu(!showTableMenu);
  };

  const insertTable = () => {
    // Restore the cursor position before inserting
    if (savedSelection) {
      editorRef.current.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedSelection);
    } else {
      ensureEditorSelection();
    }

    let thead = '<thead><tr>';
    for (let c = 0; c < tableCols; c++) thead += `<th>Header ${c + 1}</th>`;
    thead += '</tr></thead>';

    let tbody = '<tbody>';
    for (let r = 0; r < tableRows; r++) {
      tbody += '<tr>';
      for (let c = 0; c < tableCols; c++) tbody += '<td>Data</td>';
      tbody += '</tr>';
    }
    tbody += '</tbody>';

    const html = `<table border="1">${thead}${tbody}</table><p><br></p>`;
    document.execCommand('insertHTML', false, html);
    setShowTableMenu(false);
    editorRef.current.focus();
    handleInput();
  };
  const handlePaste = (e) => {
    e.preventDefault();
    const htmlData = e.clipboardData.getData('text/html');
    let textData = e.clipboardData.getData('text/plain');
    
    if (!textData && !htmlData) return;

    let md = '';
    // Heuristic: if plain text contains LaTeX markers or markdown bold/code blocks,
    // the source app's HTML clipboard flavor is usually a messy KaTeX/MathML tree
    // while the plain-text flavor is already well-formed Markdown — prefer it.
    const preferPlainText = textData && /(\$\$|\\[\[\(]|```|\*\*.*?\*\*)/.test(textData);

    if (htmlData && !preferPlainText) {
        md = turndownService.turndown(htmlData);
    } else {
        md = textData || '';
    }

    // Normalize \[..\] / \(..\) latex delimiters to standard markdown latex
    md = md.replace(/\\\[([\s\S]+?)\\\]/g, '$$$$$1$$$$');
    md = md.replace(/\\\(([\s\S]+?)\\\)/g, '$$$1$$');

    // Convert the clean markdown back to HTML for insertion. The same
    // protection as the load path, so stamps/audio cut inside the editor
    // come back as atoms instead of degrading to plain text.
    let cleanHtml = marked.parse(protectForEditor(md));

    // Insert it safely at cursor
    document.execCommand('insertHTML', false, cleanHtml);
    setTimeout(handleInput, 0);
  };


  return (
    <div className="editor-container">
      {/* preventDefault on mousedown keeps focus (and the selection) inside the
          contenteditable while a button is clicked — without it execCommand has
          no selection to act on and buttons only "sometimes" work. The table
          popover inputs are exempt: they genuinely need focus to be typed in. */}
      <div className="editor-toolbar" onMouseDown={(e) => { if (e.target.closest('input')) return; e.preventDefault(); }}>
        <button className={`toolbar-btn ${activeStyles.bold ? 'active' : ''}`} onClick={() => formatDoc('bold')} title="Bold. Select text, then click to make it bold"><Bold size={16} strokeWidth={1.5} /></button>
        <button className={`toolbar-btn ${activeStyles.italic ? 'active' : ''}`} onClick={() => formatDoc('italic')} title="Italic. Select text, then click to make it italic"><Italic size={16} strokeWidth={1.5} /></button>
        
        <div className="toolbar-divider" />
        
        <button className="toolbar-btn" style={{ color: 'inherit' }} onClick={() => formatDoc('foreColor', '#334155')} title="Reset color. Select colored text, then click to return it to normal"><PaintBucket size={16} strokeWidth={1.5} /></button>
        <button className="toolbar-btn" style={{ color: '#ef4444' }} onClick={() => formatDoc('foreColor', '#ef4444')} title="Red text. Select text, then click to mark it as critical"><PaintBucket size={16} strokeWidth={1.5} /></button>
        <button className="toolbar-btn" style={{ color: '#3b82f6' }} onClick={() => formatDoc('foreColor', '#3b82f6')} title="Blue text. Select text, then click to mark it as must-read"><PaintBucket size={16} strokeWidth={1.5} /></button>
        <button className="toolbar-btn" style={{ color: '#10b981' }} onClick={() => formatDoc('foreColor', '#10b981')} title="Green text. Select text, then click to mark it as good to know"><PaintBucket size={16} strokeWidth={1.5} /></button>

        <div className="toolbar-divider" />

        <button className="toolbar-btn" onClick={() => formatDoc('fontSize', '2')} title="Small size. Select text, then click to shrink it"><Type size={16} strokeWidth={1.5} /></button>
        <button className="toolbar-btn" onClick={() => formatDoc('fontSize', '3')} title="Normal size. Select text, then click to reset its size"><Type size={16} strokeWidth={1.5} /></button>
        <button className="toolbar-btn" onClick={() => formatDoc('fontSize', '6')} title="Large size. Select text, then click to enlarge it"><Type size={16} strokeWidth={1.5} /></button>

        <div className="toolbar-divider" />

        <button className="toolbar-btn" onClick={() => formatDoc('formatBlock', 'P')} title="Paragraph. Turns the current line into normal body text"><Baseline size={16} strokeWidth={1.5} /></button>
        <button className={`toolbar-btn ${activeStyles.h1 ? 'active' : ''}`} onClick={() => formatDoc('formatBlock', 'H1')} title="Heading 1. Turns the current line into a large section heading"><Heading1 size={16} strokeWidth={1.5} /></button>
        <button className={`toolbar-btn ${activeStyles.h2 ? 'active' : ''}`} onClick={() => formatDoc('formatBlock', 'H2')} title="Heading 2. Turns the current line into a medium heading"><Heading2 size={16} strokeWidth={1.5} /></button>
        <button className={`toolbar-btn ${activeStyles.h3 ? 'active' : ''}`} onClick={() => formatDoc('formatBlock', 'H3')} title="Heading 3. Turns the current line into a small heading"><Heading3 size={16} strokeWidth={1.5} /></button>
        
        <div className="toolbar-divider" />
        
        <button className={`toolbar-btn ${activeStyles.left ? 'active' : ''}`} onClick={() => insertAlign('left')} title="Align left. Applies to the current paragraph"><AlignLeft size={16} strokeWidth={1.5} /></button>
        <button className={`toolbar-btn ${activeStyles.center ? 'active' : ''}`} onClick={() => insertAlign('center')} title="Center. Applies to the current paragraph"><AlignCenter size={16} strokeWidth={1.5} /></button>
        <button className={`toolbar-btn ${activeStyles.right ? 'active' : ''}`} onClick={() => insertAlign('right')} title="Align right. Applies to the current paragraph"><AlignRight size={16} strokeWidth={1.5} /></button>

        <div className="toolbar-divider" />

        <button className={`toolbar-btn ${activeStyles.ul ? 'active' : ''}`} onClick={() => formatDoc('insertUnorderedList')} title="Bullet list. Turns the current line into a list item"><List size={16} strokeWidth={1.5} /></button>
        <button className={`toolbar-btn ${activeStyles.ol ? 'active' : ''}`} onClick={() => formatDoc('insertOrderedList')} title="Numbered list. Turns the current line into a numbered item"><ListOrdered size={16} strokeWidth={1.5} /></button>
        
        <div style={{ position: 'relative' }}>
          <button className="toolbar-btn" onClick={handleOpenTableMenu} title="Table. Pick rows and columns, then insert at the cursor">
            <Table size={16} strokeWidth={1.5} />
          </button>
          {showTableMenu && (
            <div className="table-creator-popover">
              <div className="table-creator-title">Insert Table</div>
              <div className="table-creator-row">
                <span>Rows</span>
                <input className="table-creator-input" type="number" min="1" max="20" value={tableRows} onChange={e => setTableRows(Math.min(20, Math.max(1, parseInt(e.target.value, 10) || 1)))} />
              </div>
              <div className="table-creator-row">
                <span>Columns</span>
                <input className="table-creator-input" type="number" min="1" max="20" value={tableCols} onChange={e => setTableCols(Math.min(20, Math.max(1, parseInt(e.target.value, 10) || 1)))} />
              </div>
              <button className="table-creator-btn" onClick={insertTable}>Insert</button>
            </div>
          )}
        </div>
        
        <div className="toolbar-divider" />
        <button className="toolbar-btn" onClick={forceNewLine} title="New line. Starts an empty line at the cursor so you can type below the current block"><CornerDownLeft size={16} strokeWidth={1.5} /></button>
      </div>
      
      {findOpen && (
        <div className="editor-find-bar">
          <input
            ref={findInputRef}
            className="editor-find-input"
            type="text"
            placeholder="Find in note"
            value={findQuery}
            onChange={(e) => { setFindQuery(e.target.value); runFind(e.target.value, 0); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); runFind(findQuery, findState.index + (e.shiftKey ? -1 : 1)); }
              else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
            }}
          />
          <span className="editor-find-count">{findState.total ? `${findState.index + 1} of ${findState.total}` : (findQuery ? 'No matches' : '')}</span>
          <button className="toolbar-btn" onClick={() => runFind(findQuery, findState.index - 1)} title="Previous match. Shortcut: Shift+Enter in the search box"><ChevronUp size={14} strokeWidth={1.5} /></button>
          <button className="toolbar-btn" onClick={() => runFind(findQuery, findState.index + 1)} title="Next match. Shortcut: Enter in the search box"><ChevronDown size={14} strokeWidth={1.5} /></button>
          <button className="toolbar-btn" onClick={closeFind} title="Close search. Shortcut: Escape"><X size={14} strokeWidth={1.5} /></button>
        </div>
      )}

      <div className="wysiwyg-wrapper" onClick={() => setShowTableMenu(false)}>
        <div
          ref={editorRef}
          className="wysiwyg-editor document-body doc-block-content"
          contentEditable={true}
          onPaste={handlePaste}
          onInput={handleInput}
          onBlur={handleInput}
          onKeyDown={handleEditorKeyDown}
          suppressContentEditableWarning={true}
        />
      </div>
    </div>
  );
}

export default Editor;
