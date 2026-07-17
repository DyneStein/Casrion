// Clipboard capture normalization — turns messy copies (AI chat sites,
// Wikipedia, spreadsheets, rendered-math pages) into clean markdown before
// insertion.
//
// Copies from rendered web apps carry two clipboard flavors:
//  - text/plain: often mangled — line breaks lost, math flattened into glyph
//    soup, citation markers left inline, tables glued together.
//  - text/html: the real structure, including the ORIGINAL LaTeX source in
//    <annotation> nodes (KaTeX/MathJax) or alt/alttext attributes (MediaWiki).
// When the HTML flavor has structure we convert it; otherwise we repair the
// plain text with conservative heuristics.

// Invisible characters that survive copies and corrupt markdown:
// zero-widths, word joiner, BOM, soft hyphen, directional marks.
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF]/g;
const JUNK_CHARS = /[\u00AD\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;
const NBSP = /[\u00A0\u2007\u202F]/g;

function hasStructuredHtml(html) {
  if (!html || !html.trim()) return false;
  return /<table|<ol[\s>]|<ul[\s>]|<h[1-6][\s>]|<pre[\s>]|<blockquote[\s>]|<dl[\s>]|<math[\s>]|katex|MathJax|mwe-math/i.test(html);
}

// "{\displaystyle x' = \frac{xd}{z}}" (MediaWiki) → "x' = \frac{xd}{z}"
function cleanTex(tex) {
  let t = (tex || '').trim();
  const m = /^\{\\displaystyle\s([\s\S]*)\}$/.exec(t);
  if (m) t = m[1].trim();
  return t;
}

function findTexIn(node) {
  // Match encoding in JS — attribute-selector case flags aren't supported by
  // the minimal DOM turndown parses into.
  if (node.querySelectorAll) {
    // Index loop: the minimal DOM's NodeList is not iterable with for...of
    const anns = node.querySelectorAll('annotation');
    for (let i = 0; i < anns.length; i++) {
      const ann = anns[i];
      const enc = (ann.getAttribute('encoding') || '').toLowerCase();
      if (enc.includes('tex') && ann.textContent && ann.textContent.trim()) {
        return cleanTex(ann.textContent);
      }
    }
  }
  const alt = node.getAttribute && (node.getAttribute('alttext') || node.getAttribute('alt'));
  if (alt && /[\\{^_]/.test(alt)) return cleanTex(alt);
  return null;
}

let cachedTurndown = null;
function buildTurndown() {
  if (cachedTurndown) return cachedTurndown;
  const TurndownService = require('turndown');
  const { gfm } = require('turndown-plugin-gfm');
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-'
  });

  // Turndown's default escaper doubles backslashes ("\frac" -> "\\frac").
  // KaTeX reads "\\" as a line break and renders the command name as plain
  // letters, so captured LaTeX ($$\frac{1}{x}$$, \times, \sqrt, …) came out
  // broken. Captured notes routinely carry LaTeX and Windows paths, so keep
  // backslashes literal while leaving turndown's other markdown escaping
  // (for *, _, [, ], #, …) untouched.
  const defaultEscape = TurndownService.prototype.escape;
  td.escape = function (string) {
    return defaultEscape.call(this, string).replace(/\\\\/g, '\\');
  };

  td.use(gfm);
  td.remove(['style', 'script', 'noscript', 'iframe', 'title', 'button', 'select', 'nav']);

  // Site chrome that must never land in a note: Wikipedia "[edit]" links,
  // citation superscripts ("[3]"), backlink carets, print-only helpers.
  td.addRule('site-chrome', {
    filter: (node) => {
      const cls = (node.getAttribute && node.getAttribute('class')) || '';
      if (/(^|\s)(mw-editsection|mw-cite-backlink|noprint|citation-needed|catlinks)(\s|$)/.test(cls)) return true;
      if (node.nodeName === 'SUP' && /(^|\s)reference(\s|$)/.test(cls)) return true;
      // Perplexity/Bing style numeric citation sups: <sup><a>3</a></sup>
      if (node.nodeName === 'SUP' && /^\s*\[?\d{1,3}\]?\s*$/.test(node.textContent || '')) return true;
      return false;
    },
    replacement: () => ''
  });

  // KaTeX spans (ChatGPT, Claude, Perplexity) carry the original TeX source
  // in an annotation node — recover it instead of the rendered glyph soup.
  td.addRule('katex-math', {
    filter: (node) => {
      const cls = (node.getAttribute && node.getAttribute('class')) || '';
      return /(^|\s)katex(-display)?(\s|$)/.test(cls);
    },
    replacement: (content, node) => {
      const tex = findTexIn(node);
      if (!tex) return content;
      const cls = (node.getAttribute && node.getAttribute('class')) || '';
      const parentCls = (node.parentNode && node.parentNode.getAttribute && node.parentNode.getAttribute('class')) || '';
      const isDisplay = /katex-display/.test(cls) || /katex-display/.test(parentCls);
      return isDisplay ? `\n\n$$${tex}$$\n\n` : `$${tex}$`;
    }
  });

  // Bare MathML <math> elements (Gemini, MediaWiki, Word exports).
  // MathML is a foreign namespace, so nodeName stays lowercase.
  td.addRule('mathml', {
    filter: (node) => String(node.nodeName).toLowerCase() === 'math',
    replacement: (content, node) => {
      const tex = findTexIn(node);
      if (!tex) return content;
      const display = (node.getAttribute && node.getAttribute('display')) === 'block';
      return display ? `\n\n$$${tex}$$\n\n` : `$${tex}$`;
    }
  });

  // Images: Wikipedia math images carry the LaTeX in their alt text — recover
  // it. All other remote images can't load offline, so keep alt text only.
  td.addRule('images', {
    filter: 'img',
    replacement: (_content, node) => {
      const cls = (node.getAttribute && node.getAttribute('class')) || '';
      const alt = (node.getAttribute && node.getAttribute('alt')) || '';
      if (/mwe-math/.test(cls) || /^\{\\displaystyle/.test(alt.trim())) {
        const tex = cleanTex(alt);
        return tex ? `\n\n$$${tex}$$\n\n` : '';
      }
      return alt;
    }
  });

  // Code blocks: sites wrap <pre> in toolbars ("Copy code", language tabs).
  // Take only the code element's text and pick up the declared language.
  td.addRule('pre-code', {
    filter: 'pre',
    replacement: (_content, node) => {
      const codeEl = (node.querySelector && node.querySelector('code')) || node;
      let text = (codeEl.textContent || '').replace(/\n$/, '');
      if (!text.trim()) return '';
      const cls = ((codeEl.getAttribute && codeEl.getAttribute('class')) || '') + ' ' + ((node.getAttribute && node.getAttribute('class')) || '');
      const langMatch = /language-([\w#+-]+)/.exec(cls);
      const lang = langMatch ? langMatch[1] : '';
      const fence = text.includes('```') ? '````' : '```';
      return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
    }
  });

  // Definition lists (Wikipedia glossaries): term in bold, definition indented
  td.addRule('definition-term', {
    filter: 'dt',
    replacement: (content) => (content.trim() ? `\n**${content.trim()}**\n` : '')
  });
  td.addRule('definition-desc', {
    filter: 'dd',
    replacement: (content) => (content.trim() ? `${content.trim()}\n` : '')
  });

  cachedTurndown = td;
  return td;
}

// Spreadsheet copies (Excel / Google Sheets) arrive as tab-separated lines.
function tsvToMarkdownTable(text) {
  const lines = (text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2 || !lines.every((l) => l.includes('\t'))) return null;
  const rows = lines.map((l) => l.split('\t').map((c) => c.trim().replace(/\|/g, '\\|')));
  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r) => { while (r.length < cols) r.push(''); return r; };
  const toRow = (r) => `| ${pad(r).join(' | ')} |`;
  const sep = `| ${Array(cols).fill('---').join(' | ')} |`;
  return [toRow(rows[0]), sep, ...rows.slice(1).map(toRow)].join('\n');
}

// Best-effort repair for plain text whose line breaks were destroyed by the
// copy: "…coordinate system:Center of Projection…$(0,0,0)$.Projection Plane…"
function reflowGluedText(text) {
  let t = text || '';
  // Display math on its own lines
  t = t.replace(/\$\$([\s\S]+?)\$\$/g, (_m, inner) => `\n\n$$${inner.trim()}$$\n\n`);
  // A colon glued straight onto a capitalized word starts a new item
  // (but never split times like 3:30 or ratios like 16:9)
  t = t.replace(/(?<!\d):(?=[A-Z])/g, ':\n');
  // Sentence end glued onto the next sentence with no space
  t = t.replace(/([.!?])(?=[A-Z][a-z])/g, '$1\n');
  // Closing paren glued onto the next capitalized word: "(Similar Triangles)Let's"
  t = t.replace(/\)(?=[A-Z][a-z])/g, ')\n');
  t = t.replace(/\.(?=\d[A-Za-z])/g, '.\n'); // "….3D Point"
  t = t.replace(/\n{3,}/g, '\n\n');
  return t;
}

// Captured text must arrive color-neutral: re-capturing something that was
// previously colored (or copied from a styled page) keeps the old color
// forever otherwise. Colors are applied intentionally via Alt+R/G/B only.
function stripColorMarkup(md) {
  let out = md || '';
  let prev;
  do {
    prev = out;
    out = out.replace(/<span\s[^>]*style="[^"]*color\s*:[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, '$1');
    out = out.replace(/<font\s[^>]*color\s*=\s*"[^"]*"[^>]*>([\s\S]*?)<\/font>/gi, '$1');
  } while (out !== prev);
  return out;
}

function stripJunkChars(s) {
  return (s || '').replace(ZERO_WIDTH, '').replace(JUNK_CHARS, '').replace(NBSP, ' ');
}

function cleanupMarkdown(md) {
  let out = stripJunkChars(md);
  out = stripColorMarkup(out);
  out = out
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out;
}

// Structured content must be inserted as its own block; a bare sentence can
// continue the current paragraph.
function isStructured(md) {
  return /\n/.test(md) || /^(#{1,6}\s|[-*]\s|\d+\.\s|>|```|\||\$\$)/.test(md);
}

function normalizeCapture(rawText, rawHtml) {
  const text = stripJunkChars(rawText);

  if (hasStructuredHtml(rawHtml)) {
    try {
      const md = cleanupMarkdown(buildTurndown().turndown(rawHtml));
      if (md) return { content: md, structured: isStructured(md) };
    } catch (e) {
      console.error('[Casrion] HTML normalization failed, using plain text:', e.message);
    }
  }

  const table = tsvToMarkdownTable(text);
  if (table) return { content: table, structured: true };

  const repaired = cleanupMarkdown(reflowGluedText(text));
  return { content: repaired, structured: isStructured(repaired) };
}

module.exports = { normalizeCapture, tsvToMarkdownTable, reflowGluedText, hasStructuredHtml, stripColorMarkup };
