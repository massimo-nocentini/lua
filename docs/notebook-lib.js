/* notebook-lib.js - pure helpers for the Notebook tab (notebook.js)
 *
 * Part of the WebAssembly/Docker port of Lua; same license as Lua (see the Copyright Notice in lua.h).
 * The markdown renderer and the markup sanitizer are CHICKEN's (emscripten/web/notebook-lib.js of
 * the CHICKEN Scheme WebAssembly port), unchanged but for the code blocks they color.
 */

/* UMD: a CommonJS module in node (emscripten/tests/wasm/lib-harness.js),
 * the global LuaNotebookLib in the page.  No dependencies; the DOM is only
 * touched through the document passed in (renderMarkdown, sanitizeMarkup).
 *
 *   renderMarkdown(src, doc, idPrefix, ids?, lazy?) -> DocumentFragment
 *   sanitizeMarkup(str, 'html'|'svg', idPrefix) -> DocumentFragment
 *   splitPercent(text) -> {title, cells}  toPercent(nb) -> string    (.lua)
 *   toJson(nb) -> string                  fromJson(text) -> {title, created,
 *                                           modified, cells, warnings}
 *   limitOutputs(outputs, max) -> outputs (as Import keeps them)
 *   balance(text) -> {depth, ok, stray, mismatch, open, unclosed, text}
 *   opensBlock(line) -> boolean           (auto-indent: indent the next line)
 *   splitChunks(text) -> [string]         newId() -> string
 *   highlight(text) -> [[kind, text]]     highlightLines(pieces) -> [[[kind, text]]]
 *   highlightDom(text, doc) -> DocumentFragment
 *   colorCode(root, doc)                  (the code blocks of a lazy renderMarkdown)
 *   straightenQuotes(s) -> string         (LuaPage.straightenQuotes)
 *
 * Untrusted markup is parsed inertly (DOMParser) and rebuilt element by
 * element from an allowlist; nothing is ever serialized back into
 * markup, and no innerHTML is used.  Markdown is built with
 * createElement and text nodes only.
 *
 * The Lua scanners (scan, highlight, straightenQuotes) follow llex.c:
 * short strings with their escapes (a backslash-newline and \z continue
 * the string, an unescaped newline ends it, unfinished), long brackets
 * [==[ ... ]==] of any level, "--" comments to the end of the line and
 * --[==[ ... ]==] long comments.  Each runs in time linear in its input:
 * a closing bracket is found with indexOf, tokens with sticky regular
 * expressions, and nothing is ever sliced off the rest of the text (a
 * page reload highlights every saved cell). */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LuaNotebookLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';

  // ---- URLs

  // a link target: http, https, mailto or a fragment; returns the URL to
  // use, or null.  The URL parser drops tabs and newlines, so
  // "jav&#x09;ascript:" is caught as javascript:.
  function safeHref(u) {
    if (typeof u !== 'string') return null;
    const t = u.trim();
    if (t.startsWith('#')) return /^#[^\s"'<>`]*$/.test(t) ? t : null;
    let url;
    try { url = new URL(t); } catch (e) { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null;
    return url.href;
  }
  const IMG_DATA = /^data:image\/(png|jpeg|gif|webp)(;[a-z0-9=._-]+)*;base64,/i;
  function safeImageSrc(u) {
    if (typeof u !== 'string') return null;
    const t = u.trim(), m = IMG_DATA.exec(t);
    if (!m) return null;
    const b64 = t.slice(m[0].length).replace(/\s+/g, '');
    return /^[A-Za-z0-9+/]*={0,2}$/.test(b64) ? m[0] + b64 : null;
  }
  function slug(s) {
    return String(s).toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-').slice(0, 64) || 'section';
  }

  // ---- markdown (CommonMark-ish subset)

  // Time is linear in the source: no regular expression here may
  // backtrack over a long run (a page reload renders saved cells).

  function trimTail(s) {                 // trailing spaces and tabs
    let e = s.length;
    while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e--;
    return s.slice(0, e);
  }

  const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

  // Linear in s: brackets are matched once (bracketPairs), a failed
  // search for an emphasis closer is not repeated (noCloser), code span
  // closers are looked up in an index of the backtick runs (tickRuns),
  // and text is flushed at each line end.
  function inline(doc, s, out, depth) {
    // out: a node to append to
    depth = depth || 0;
    if (depth > 32) { out.appendChild(doc.createTextNode(s)); return out; }
    let i = 0, text = '', pairs = null, runs = null;
    const noCloser = {};
    const flush = () => { if (text) { out.appendChild(doc.createTextNode(text)); text = ''; } };
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === '\\' && i + 1 < n && ESCAPABLE.test(s[i + 1])) { text += s[i + 1]; i += 2; continue; }
      if (c === '\\' && s[i + 1] === '\n') { flush(); out.appendChild(doc.createElement('br')); i += 2; continue; }
      if (c === '\n') {
        // two trailing spaces: a hard break.  A text node per line keeps
        // the trailing spaces cheap to find.
        let e = text.length;
        while (e > 0 && text[e - 1] === ' ') e--;
        const hard = text.length - e >= 2;
        text = text.slice(0, e);
        if (hard) { flush(); out.appendChild(doc.createElement('br')); }
        else { text += '\n'; flush(); }
        i++;
        while (s[i] === ' ') i++;
        continue;
      }
      if (c === '`') {
        let j = i; while (s[j] === '`') j++;
        const ticks = s.slice(i, j);
        const e = tickCloser(runs || (runs = tickRuns(s)), j - i, j);
        if (e >= 0) {
          flush();
          let code = s.slice(j, e).replace(/\n/g, ' ');
          if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code))
            code = code.slice(1, -1);
          const el = doc.createElement('code');
          el.textContent = code;
          out.appendChild(el);
          i = e + ticks.length;
          continue;
        }
        text += ticks; i = j; continue;
      }
      if (c === '<') {
        const m = /^<((?:https?|mailto):[^\s<>]*)>/i.exec(s.slice(i));
        if (m) {
          const href = safeHref(m[1]);
          flush();
          if (href) out.appendChild(link(doc, href, m[1])); else out.appendChild(doc.createTextNode(m[1]));
          i += m[0].length;
          continue;
        }
      }
      if (c === 'h' && /^https?:\/\//.test(s.slice(i, i + 8)) && (i === 0 || /[\s(]/.test(s[i - 1]))) {
        const m = /^https?:\/\/[^\s<>]+/.exec(s.slice(i));
        let e = m[0].length;
        while (e > 0 && `.,;:!?'")]`.includes(m[0][e - 1])) e--;
        const u = m[0].slice(0, e), href = safeHref(u);
        if (href) { flush(); out.appendChild(link(doc, href, u)); } else text += u;
        i += u.length;
        continue;
      }
      if (c === '!' && s[i + 1] === '[') {
        const r = linkAt(s, i + 1, pairs || (pairs = bracketPairs(s, runs || (runs = tickRuns(s)))));
        if (r) {
          flush();
          const src = safeImageSrc(r.url);
          if (src) {
            const img = doc.createElement('img');
            img.src = src;
            img.alt = r.label;
            if (r.title) img.title = r.title;
            out.appendChild(img);
          } else {
            const sp = doc.createElement('span');
            sp.className = 'md-noimg';
            sp.textContent = (r.label || 'image') + ' (external image not loaded)';
            out.appendChild(sp);
          }
          i = r.end;
          continue;
        }
      }
      if (c === '[') {
        const r = linkAt(s, i, pairs || (pairs = bracketPairs(s, runs || (runs = tickRuns(s)))));
        if (r) {
          flush();
          const href = safeHref(r.url);
          if (href) {
            const a = link(doc, href, null);
            if (r.title) a.title = r.title;
            inline(doc, r.label, a, depth + 1);
            out.appendChild(a);
          } else {
            const sp = doc.createElement('span');
            inline(doc, r.label, sp, depth + 1);
            out.appendChild(sp);
          }
          i = r.end;
          continue;
        }
      }
      if (c === '*' || c === '_' || c === '~') {
        const r = emphasisAt(s, i, noCloser);
        if (r) {
          flush();
          const el = doc.createElement(r.tag);
          inline(doc, r.inner, el, depth + 1);
          out.appendChild(el);
          i = r.end;
          continue;
        }
      }
      text += c;
      i++;
    }
    flush();
    return out;
  }

  function link(doc, href, label) {
    const a = doc.createElement('a');
    a.setAttribute('href', href);
    if (!href.startsWith('#')) {
      a.setAttribute('rel', 'noopener noreferrer');
      a.setAttribute('target', '_blank');
    }
    if (label != null) a.textContent = label;
    return a;
  }

  // The runs of backticks in s, as a Map from length to their starts in
  // order.  A code span ends at the next run exactly as long as the one
  // that opens it (as in CommonMark), found by a binary search: searching
  // the rest of s for each opener would be quadratic.
  function tickRuns(s) {
    const runs = new Map();
    for (let p = s.indexOf('`'); p >= 0; ) {
      let e = p + 1; while (s[e] === '`') e++;
      let a = runs.get(e - p);
      if (!a) runs.set(e - p, a = []);
      a.push(p);
      p = s.indexOf('`', e);
    }
    return runs;
  }
  // the start of the first run of exactly LEN backticks at or after FROM, or -1
  function tickCloser(runs, len, from) {
    const a = runs.get(len);
    if (!a) return -1;
    let lo = 0, hi = a.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < from) lo = m + 1; else hi = m; }
    return lo < a.length ? a[lo] : -1;
  }

  // "[" index -> its "]" index, outside escapes and code spans
  function bracketPairs(s, runs) {
    const pairs = new Map(), open = [];
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') { j++; continue; }
      if (c === '`') {
        let k = j; while (s[k] === '`') k++;
        const e = tickCloser(runs, k - j, k);
        j = (e >= 0 ? e + k - j : k) - 1;
        continue;
      }
      if (c === '[') open.push(j);
      else if (c === ']' && open.length) pairs.set(open.pop(), j);
    }
    return pairs;
  }

  // [label](url "title") starting at s[i] === '['
  function linkAt(s, i, pairs) {
    const j = pairs.get(i);
    if (j === undefined || s[j + 1] !== '(') return null;
    const m = /^\(\s*(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+("[^"]*"|'[^']*'))?\s*\)/.exec(s.slice(j + 1));
    if (!m) return null;
    let url = m[1];
    if (url.startsWith('<')) url = url.slice(1, -1);
    return { label: s.slice(i + 1, j), url, title: m[2] ? m[2].slice(1, -1) : '', end: j + 1 + m[0].length };
  }

  // noCloser[d]: a search for a closer d from there on found none
  function emphasisAt(s, i, noCloser) {
    const c = s[i];
    const dbl = s[i + 1] === c;
    if (c === '~' && !dbl) return null;
    const tryDelim = (d, tag) => {
      const after = s[i + d.length];
      if (!after || /\s/.test(after)) return null;
      // _ inside words is not emphasis
      if (c === '_' && i > 0 && /[\p{L}\p{N}]/u.test(s[i - 1])) return null;
      let k = i + d.length;
      if (noCloser[d] !== undefined && k >= noCloser[d]) return null;
      const from = k;
      while ((k = s.indexOf(d, k + 1)) > 0) {
        if (/\s/.test(s[k - 1]) || s[k - 1] === '\\') continue;
        if (d.length === 1 && s[k + 1] === c) {
          // "**" inside "*...*": skip the pair
          if (s[k - 1] !== c) { k++; continue; }
        }
        if (c === '_' && /[\p{L}\p{N}]/u.test(s[k + d.length] || '')) continue;
        return { tag, inner: s.slice(i + d.length, k), end: k + d.length };
      }
      noCloser[d] = from;
      return null;
    };
    if (c === '~') return tryDelim('~~', 'del');
    if (dbl) {
      const r = tryDelim(c + c, 'strong');
      if (r) return r;
    }
    return tryDelim(c, 'em');
  }

  // a fence line: [line, indent, fence, language] or null
  function fenceOf(l) {
    const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(l);
    return m && !m[3].includes('`') ? [l, m[1], m[2], /^\s*(\S*)/.exec(m[3])[1]] : null;
  }
  // an ATX heading: [line, hashes, text] or null
  function headingOf(l) {
    let i = 0;
    while (i < 3 && l[i] === ' ') i++;
    let j = i;
    while (l[j] === '#') j++;
    if (j === i || j - i > 6 || (j < l.length && l[j] !== ' ' && l[j] !== '\t')) return null;
    let t = trimTail(l.slice(j)).replace(/^[ \t]+/, '');
    let e = t.length;
    while (e > 0 && t[e - 1] === '#') e--;    // a closing sequence
    if (e === 0) t = '';
    else if (e < t.length && (t[e - 1] === ' ' || t[e - 1] === '\t')) t = trimTail(t.slice(0, e));
    return [l, l.slice(i, j), t];
  }
  const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const RE_LIST = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
  const RE_QUOTE = /^ {0,3}> ?/;
  const RE_TABLE_DELIM = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;     // on a trimmed line
  const isDelim = l => l.includes('-') && RE_TABLE_DELIM.test(l.trim());
  const blank = l => /^\s*$/.test(l);

  function splitRow(l) {
    let t = l.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++; }
      else if (t[i] === '|') { cells.push(cur.trim()); cur = ''; }
      else cur += t[i];
    }
    cells.push(cur.trim());
    return cells;
  }

  function startsBlock(l) {
    return headingOf(l) || fenceOf(l) || RE_HR.test(l) || RE_QUOTE.test(l) ||
      /^ {0,3}([-*+]|1[.)])[ \t]+\S/.test(l);
  }

  function blocks(doc, lines, out, prefix, ids, depth) {
    let i = 0;
    const n = lines.length;
    while (i < n) {
      const l = lines[i];
      if (blank(l)) { i++; continue; }
      let m;
      if ((m = fenceOf(l))) {
        const fence = m[2], ind = m[1].length;
        const body = [];
        i++;
        while (i < n && !new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}\\s*$').test(lines[i])) {
          body.push(lines[i].replace(new RegExp('^ {0,' + ind + '}'), ''));
          i++;
        }
        i++;
        const pre = doc.createElement('pre'), code = doc.createElement('code'), text = body.join('\n');
        if (m[3]) code.setAttribute('data-lang', m[3].slice(0, 32));
        code.textContent = text;
        // Lua (or no language), to be colored by colorCode()
        if (/^(?:lua)?$/i.test(m[3] || '')) code.setAttribute('data-syn', '');
        pre.appendChild(code);
        out.appendChild(pre);
        continue;
      }
      if ((m = headingOf(l))) {
        const h = doc.createElement('h' + m[1].length);
        const txt = m[2] || '';
        let id = prefix + slug(txt), k = 2;
        while (ids.has(id)) id = prefix + slug(txt) + '-' + k++;
        ids.add(id);
        h.id = id;
        inline(doc, txt, h);
        out.appendChild(h);
        i++;
        continue;
      }
      if (RE_HR.test(l)) { out.appendChild(doc.createElement('hr')); i++; continue; }
      if (RE_QUOTE.test(l)) {
        const body = [];
        while (i < n && (RE_QUOTE.test(lines[i]) || (!blank(lines[i]) && body.length && !startsBlock(lines[i])))) {
          body.push(lines[i].replace(RE_QUOTE, ''));
          i++;
        }
        const bq = doc.createElement('blockquote');
        if (depth < 16) blocks(doc, body, bq, prefix, ids, depth + 1);
        out.appendChild(bq);
        continue;
      }
      if ((m = RE_LIST.exec(l))) {
        const ordered = /\d/.test(m[2]);
        const list = doc.createElement(ordered ? 'ol' : 'ul');
        if (ordered && parseInt(m[2], 10) !== 1) list.setAttribute('start', String(parseInt(m[2], 10)));
        const baseInd = m[1].length;
        while (i < n) {
          const mm = RE_LIST.exec(lines[i]);
          if (!mm || mm[1].length !== baseInd || /\d/.test(mm[2]) !== ordered) break;
          const contentInd = mm[1].length + mm[2].length + Math.max(1, Math.min(4, mm[3].length));
          const body = [mm[4]];
          i++;
          let sawBlank = false;
          while (i < n) {
            const x = lines[i];
            if (blank(x)) { sawBlank = true; body.push(''); i++; continue; }
            const ind = x.length - x.trimStart().length;
            if (ind >= contentInd || (ind > baseInd && RE_LIST.test(x))) {
              body.push(x.slice(Math.min(ind, contentInd)));
              sawBlank = false;
              i++;
              continue;
            }
            if (!sawBlank && !startsBlock(x) && !RE_LIST.test(x)) { body.push(x.trim()); i++; continue; }
            break;
          }
          while (body.length && blank(body[body.length - 1])) body.pop();
          const li = doc.createElement('li');
          const tight = !body.some(blank);
          if (depth < 16) {
            if (tight && !body.slice(1).some(x => startsBlock(x) || RE_LIST.test(x) || /^ {4}/.test(x))) inline(doc, body.join('\n'), li);
            else {
              blocks(doc, body, li, prefix, ids, depth + 1);
              // tight lists: unwrap single paragraphs
              if (tight && li.firstChild && li.firstChild.nodeName === 'P') {
                const p = li.firstChild;
                while (p.firstChild) li.insertBefore(p.firstChild, p);
                li.removeChild(p);
              }
            }
          }
          list.appendChild(li);
          if (i < n && blank(lines[i - 1] || 'x') && !RE_LIST.test(lines[i])) break;
        }
        out.appendChild(list);
        continue;
      }
      if (/^ {4}/.test(l) || /^\t/.test(l)) {
        const body = [];
        while (i < n && (/^ {4}|^\t/.test(lines[i]) || (blank(lines[i]) && i + 1 < n && /^ {4}|^\t/.test(lines[i + 1])))) {
          body.push(lines[i].replace(/^( {4}|\t)/, ''));
          i++;
        }
        const pre = doc.createElement('pre'), code = doc.createElement('code');
        code.textContent = body.join('\n');
        pre.appendChild(code);
        out.appendChild(pre);
        continue;
      }
      if (l.includes('|') && i + 1 < n && isDelim(lines[i + 1])) {
        const head = splitRow(l);
        const aligns = splitRow(lines[i + 1]).map(d => /^:-+:$/.test(d) ? 'center' : /-:$/.test(d) ? 'right' : /^:/.test(d) ? 'left' : '');
        if (aligns.length === head.length) {
          i += 2;
          const table = doc.createElement('table'), thead = doc.createElement('thead'), tr = doc.createElement('tr');
          head.forEach((h, k) => {
            const th = doc.createElement('th');
            if (aligns[k]) th.style.textAlign = aligns[k];
            inline(doc, h, th);
            tr.appendChild(th);
          });
          thead.appendChild(tr);
          table.appendChild(thead);
          const tbody = doc.createElement('tbody');
          while (i < n && !blank(lines[i]) && lines[i].includes('|')) {
            const row = splitRow(lines[i]);
            const r = doc.createElement('tr');
            // a short row gets one cell for the missing ones: the DOM
            // stays linear in the source (N columns, N rows of "|")
            const m = Math.min(row.length, head.length);
            for (let k = 0; k < m; k++) {
              const td = doc.createElement('td');
              if (aligns[k]) td.style.textAlign = aligns[k];
              inline(doc, row[k], td);
              r.appendChild(td);
            }
            if (m < head.length) {
              const td = doc.createElement('td');
              td.setAttribute('colspan', String(head.length - m));
              r.appendChild(td);
            }
            tbody.appendChild(r);
            i++;
          }
          table.appendChild(tbody);
          const wrap = doc.createElement('div');
          wrap.className = 'md-table';
          wrap.appendChild(table);
          out.appendChild(wrap);
          continue;
        }
      }
      // paragraph
      const para = [];
      while (i < n && !blank(lines[i]) && !(para.length && startsBlock(lines[i])) &&
             !(para.length && lines[i].includes('|') && i + 1 < n && isDelim(lines[i + 1]))) {
        para.push(lines[i]);
        i++;
      }
      if (!para.length) { para.push(lines[i]); i++; }
      const p = doc.createElement('p');
      inline(doc, trimTail(para.join('\n').replace(/^ +/, '')), p);
      out.appendChild(p);
    }
  }

  // ids: heading ids taken (by other cells), and given to the new ones;
  // lazy: the Lua code blocks are left for colorCode()
  function renderMarkdown(src, doc, idPrefix, ids, lazy) {
    const frag = doc.createDocumentFragment();
    const prefix = idPrefix || '';
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    blocks(doc, lines, frag, prefix, ids || new Set(), 0);
    // "#slug" links go to the headings, whose ids carry the prefix
    for (const a of frag.querySelectorAll('a[href^="#"]'))
      a.setAttribute('href', '#' + prefix + a.getAttribute('href').slice(1));
    if (!lazy) colorCode(frag, doc);
    return frag;
  }

  // ---- markup sanitizer

  const HTML_OK = new Set(('a abbr b bdi bdo blockquote br caption cite code col colgroup dd del details dfn div dl dt em ' +
    'figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark meter ol p pre progress q rp rt ruby s samp small ' +
    'span strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr section article header footer ' +
    'aside nav main hgroup address center font big tt strike').split(' '));
  // dropped with everything inside
  const HTML_DROP = new Set(('script style template noscript iframe frame frameset object embed applet form input button ' +
    'select textarea option optgroup datalist output label fieldset legend dialog math link meta base title head ' +
    'audio video source track picture canvas map area portal slot noembed noframes xmp plaintext marquee svg:image').split(' '));
  const SVG_OK = new Set(('svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath ' +
    'title desc linearGradient radialGradient stop clipPath mask pattern marker filter a switch ' +
    'feBlend feColorMatrix feComponentTransfer feComposite feDiffuseLighting feDisplacementMap feDistantLight ' +
    'feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feMerge feMergeNode feMorphology feOffset ' +
    'fePointLight feSpecularLighting feSpotLight feTile feTurbulence').split(' '));
  const HTML_ATTRS = {
    '*': ['title', 'lang', 'dir', 'id', 'style', 'role', 'align', 'width', 'height', 'hidden'],
    a: ['href'], img: ['src', 'alt'], td: ['colspan', 'rowspan', 'valign'], th: ['colspan', 'rowspan', 'scope', 'valign'],
    col: ['span'], colgroup: ['span'], ol: ['start', 'reversed', 'type'], ul: ['type'], li: ['value'],
    progress: ['value', 'max'], meter: ['value', 'min', 'max', 'low', 'high', 'optimum'], time: ['datetime'],
    details: ['open'], table: ['border', 'cellpadding', 'cellspacing'], font: ['color', 'size'], abbr: [], dfn: [],
  };
  const SVG_ATTRS = new Set(('id style x y x1 y1 x2 y2 cx cy r rx ry fx fy fr width height d points transform viewBox ' +
    'preserveAspectRatio fill fill-opacity fill-rule stroke stroke-width stroke-linecap stroke-linejoin ' +
    'stroke-dasharray stroke-dashoffset stroke-opacity stroke-miterlimit opacity color font-family font-size ' +
    'font-weight font-style font-variant text-anchor dominant-baseline alignment-baseline baseline-shift ' +
    'letter-spacing word-spacing text-decoration writing-mode dx dy rotate textLength lengthAdjust startOffset ' +
    'offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod patternUnits patternContentUnits ' +
    'patternTransform clipPathUnits maskUnits maskContentUnits clip-path clip-rule mask marker-start marker-mid ' +
    'marker-end markerWidth markerHeight markerUnits refX refY orient filter filterUnits primitiveUnits in in2 ' +
    'result stdDeviation mode operator k1 k2 k3 k4 type tableValues slope intercept amplitude exponent ' +
    'baseFrequency numOctaves seed stitchTiles scale xChannelSelector yChannelSelector flood-color flood-opacity ' +
    'lighting-color radius surfaceScale diffuseConstant specularConstant specularExponent kernelUnitLength azimuth ' +
    'elevation pointsAtX pointsAtY pointsAtZ limitingConeAngle z display visibility overflow vector-effect ' +
    'shape-rendering text-rendering image-rendering paint-order pathLength version role systemLanguage ' +
    'aria-label aria-hidden aria-labelledby aria-describedby tabindex href').split(' '));
  // image-set(), src(), image() and cross-fade() load images without url()
  const BAD_CSS = /url\s*\(|image-set|src\s*\(|image\s*\(|cross-fade|element\s*\(|expression|@import|-moz-binding|behavior|javascript:|\\|<|>/i;
  // The only CSS functions an SVG attribute may use (most of them are
  // presentation attributes, which are CSS values), and no escapes.
  const CSS_FUNCS = new Set(('url rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix light-dark ' +
    'calc min max clamp round mod rem abs sign sin cos tan asin acos atan atan2 pow sqrt hypot log exp ' +
    'matrix matrix3d translate translatex translatey translatez translate3d scale scalex scaley scalez scale3d ' +
    'rotate rotatex rotatey rotatez rotate3d skew skewx skewy perspective ' +
    'blur brightness contrast drop-shadow grayscale hue-rotate invert opacity saturate sepia ' +
    'inset circle ellipse polygon path rect xywh linear-gradient radial-gradient conic-gradient ' +
    'repeating-linear-gradient repeating-radial-gradient repeating-conic-gradient').split(' '));
  function cssValueOk(v) {
    if (v.includes('\\')) return false;
    for (const m of v.matchAll(/([a-zA-Z_-][\w-]*)\s*\(/g)) if (!CSS_FUNCS.has(m[1].toLowerCase())) return false;
    return true;
  }

  function cleanStyle(v, prefix) {
    const keep = [];
    for (const decl of String(v).split(';')) {
      const d = decl.trim();
      if (!d || !/^[-a-zA-Z]+\s*:/.test(d)) continue;
      const fragOnly = d.replace(/url\(\s*(['"]?)#([\w.:-]+)\1\s*\)/g, (_, q, id) => 'URLFRAG' + id + 'URLFRAG');
      if (BAD_CSS.test(fragOnly)) continue;
      keep.push(fragOnly.replace(/URLFRAG([\w.:-]+)URLFRAG/g, (_, id) => 'url(#' + prefix + id + ')'));
    }
    return keep.join('; ');
  }
  const fixId = (prefix, id) => prefix + String(id).replace(/[^\w.:-]/g, '_').slice(0, 64);
  // the attributes that name ids: the markup's own, never the page's
  const ID_REFS = new Set(('aria-labelledby aria-describedby aria-owns aria-controls aria-activedescendant ' +
    'aria-details aria-flowto aria-errormessage').split(' '));

  function cleanAttr(el, name, value, svg, prefix) {
    // returns the value to set, or null to drop it
    if (/^on/i.test(name) || name === 'srcdoc' || name === 'formaction' || name === 'class' ||
        name.includes(':') && name !== 'xlink:href') return null;
    const v = String(value);
    if (name === 'style') { const s = cleanStyle(v, prefix); return s || null; }
    if (name === 'id') return fixId(prefix, v);
    // focusable or not, but never ahead of the page in the Tab order
    if (name === 'tabindex') return Number(v) < 0 ? '-1' : '0';
    if (ID_REFS.has(name))
      return v.split(/\s+/).filter(Boolean).map(x => fixId(prefix, x)).join(' ');
    if (name === 'href' || name === 'xlink:href') {
      const tag = el.localName;
      const h = safeHref(v);
      if (!h) return null;
      if (h.startsWith('#')) return '#' + fixId(prefix, h.slice(1));
      return tag === 'a' ? h : null;      // use, textPath, gradients: fragments only
    }
    if (name === 'src') return el.localName === 'img' && !svg ? safeImageSrc(v) : null;
    if (svg && name !== 'role' && !/^aria-/.test(name) && !cssValueOk(v)) return null;
    if (/url\s*\(/i.test(v)) {
      const m = /^\s*url\(\s*(['"]?)#([\w.:-]+)\1\s*\)\s*(.*)$/.exec(v);
      if (!m || /url\s*\(/i.test(m[3])) return null;
      return 'url(#' + fixId(prefix, m[2]) + ')' + (m[3] ? ' ' + m[3] : '');
    }
    if (/javascript:|data:|vbscript:/i.test(v.replace(/[\s\u0000-\u001f]/g, ''))) return null;
    return v;
  }

  function rebuild(doc, src, parent, prefix, depth) {
    if (depth > 64) return;
    for (let n = src.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 || n.nodeType === 4) {     // text, CDATA
        parent.appendChild(doc.createTextNode(n.nodeValue));
        continue;
      }
      if (n.nodeType !== 1) continue;
      const ns = n.namespaceURI;
      const svg = ns === SVG_NS;
      // in SVG only SVG (there is no foreignObject): an HTML element in
      // it, which only XML can make, shows nothing and would be parsed
      // out of the SVG if the markup were read again (Export .html)
      if (!svg && parent.namespaceURI === SVG_NS) continue;
      const tag = svg ? n.localName : String(n.localName).toLowerCase();
      let ok;
      if (svg) ok = SVG_OK.has(tag);
      else if (ns === HTML_NS || ns === null) ok = HTML_OK.has(tag) && !HTML_DROP.has(tag);
      else ok = false;
      if (!ok) {
        // unknown harmless wrappers keep their (sanitized) content
        const drop = svg || ns !== HTML_NS || HTML_DROP.has(tag) || /^(script|style|iframe|object|embed)$/i.test(tag);
        if (!drop) rebuild(doc, n, parent, prefix, depth + 1);
        continue;
      }
      const el = svg ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
      const allowed = svg ? null : new Set([...(HTML_ATTRS['*']), ...(HTML_ATTRS[tag] || [])]);
      for (const a of [...n.attributes]) {
        let name = a.namespaceURI === XLINK_NS && a.localName === 'href' ? 'xlink:href' : a.name;
        const lname = svg ? name : name.toLowerCase();
        const isAria = /^aria-[a-z]+$/.test(lname);
        if (svg ? !(SVG_ATTRS.has(lname) || isAria || lname === 'xlink:href') : !(allowed.has(lname) || isAria)) continue;
        const v = cleanAttr(n, lname, a.value, svg, prefix);
        if (v == null) continue;
        try { el.setAttribute(lname === 'xlink:href' ? 'href' : lname, v); } catch (e) { /* invalid name */ }
      }
      if (tag === 'a' && el.hasAttribute('href') && !el.getAttribute('href').startsWith('#')) {
        el.setAttribute('rel', 'noopener noreferrer');
        el.setAttribute('target', '_blank');
      }
      if (tag === 'img' && !el.hasAttribute('src')) {
        const alt = n.getAttribute('alt');
        if (alt) parent.appendChild(doc.createTextNode(alt));
        continue;
      }
      rebuild(doc, n, el, prefix, depth + 1);
      parent.appendChild(el);
    }
  }

  // <use> copies its target, which may hold more <use>: ten uses of a
  // group of ten uses of ... render 10^6 elements from a kilobyte.  The
  // rendered size of each <use> (its target's elements, uses expanded)
  // is counted, and a <use> that would take the total for the markup
  // past BUDGET is dropped, as is one in a cycle or in a chain deeper
  // than USE_CHAIN.  (Ids are prefixed per output, so a <use> only
  // finds its target in the same markup.)
  const USE_CHAIN = 16;
  function limitUses(root, budget) {
    const uses = [...root.querySelectorAll('use')];
    if (!uses.length) return;
    const byId = new Map();
    for (const e of root.querySelectorAll('[id]')) if (!byId.has(e.id)) byId.set(e.id, e);
    const target = u => {
      const h = u.getAttribute('href');
      return h && h[0] === '#' ? byId.get(h.slice(1)) : undefined;
    };
    const memo = new Map();
    // EL's rendered elements, uses expanded; Infinity in a cycle
    function weight(el, chain) {
      if (memo.has(el)) return memo.get(el);
      if (chain > USE_CHAIN) return Infinity;
      memo.set(el, Infinity);
      let w = 1;
      if (el.localName === 'use') { const t = target(el); if (t) w += weight(t, chain + 1); }
      for (let c = el.firstElementChild; c && w <= budget; c = c.nextElementSibling) w += weight(c, chain);
      if (w > budget) w = Infinity;
      memo.set(el, w);
      return w;
    }
    let total = 0;
    for (const u of uses) {
      if (!root.contains(u)) continue;    // inside a dropped one
      const t = target(u);
      const w = t ? weight(t, 1) : 0;
      if (total + w > budget) u.remove(); else total += w;
    }
  }

  // A filter costs about its primitives times the area it covers, for
  // every element it applies to, at every paint: twenty 800x800 rects
  // sharing a filter of five blurs and dilations take minutes to paint,
  // from 1.7 KB.  Each element with a filter (SVG or CSS, or a shadow)
  // is charged its weight (its primitives, kernel sizes counting) times
  // the copies of it that are rendered (uses counting), and loses it
  // when the total for the markup would go past FILTER_BUDGET (a blur
  // weighs 4), so that what is kept costs about as much as 16 blurs of
  // the whole output, at most (in headless Chromium and Firefox, which
  // paint in software, 0.6 s per paint of an 800x800 SVG, 1.5 s of a
  // 1200x800 HTML element).  So does a filter inside a mask, pattern,
  // marker or clip path, painted once per user (or vertex).
  const FILTER_BUDGET = 64;
  const FE_WEIGHT = { feGaussianBlur: 4, feDropShadow: 5, feDiffuseLighting: 3, feSpecularLighting: 3,
                      feDisplacementMap: 2, feMerge: 0, feMergeNode: 1, feDistantLight: 0, fePointLight: 0,
                      feSpotLight: 0, feFuncA: 0, feFuncB: 0, feFuncG: 0, feFuncR: 0 };
  const FILTER_PROPS = /^\s*(filter|-webkit-filter|backdrop-filter|-webkit-backdrop-filter|box-shadow|text-shadow)\s*:/i;
  const NOT_RENDERED = new Set(['defs', 'symbol', 'clipPath', 'mask', 'pattern', 'marker', 'linearGradient',
                                'radialGradient', 'filter', 'title', 'desc']);
  const REPAINTED = new Set(['clipPath', 'mask', 'pattern', 'marker']);
  function limitFilters(root) {
    const els = [...root.querySelectorAll('*')];
    const byId = new Map(), usesOf = new Map();
    for (const e of els) if (e.id && !byId.has(e.id)) byId.set(e.id, e);
    for (const u of els) {
      if (u.localName !== 'use') continue;
      const h = u.getAttribute('href'), t = h && h[0] === '#' && byId.get(h.slice(1));
      if (t) { if (!usesOf.has(t)) usesOf.set(t, []); usesOf.get(t).push(u); }
    }
    const num = v => { const n = Number(v); return isFinite(n) ? Math.abs(n) : 0; };
    const fweights = new Map();
    function filterWeight(f) {
      if (!f || f.localName !== 'filter') return 0;
      if (fweights.has(f)) return fweights.get(f);
      fweights.set(f, 0);                 // an href cycle
      let w = 0, prims = 0;
      for (const p of f.querySelectorAll('*')) {
        const n = p.localName;
        prims++;
        if (n === 'feMorphology')
          w += 1 + Math.max(0, ...String(p.getAttribute('radius') || '').split(/[\s,]+/).map(num)) / 4;
        else if (n === 'feTurbulence') w += 2 * Math.max(1, num(p.getAttribute('numOctaves') || 1));
        else w += n in FE_WEIGHT ? FE_WEIGHT[n] : 1;
      }
      // a filter without primitives takes those of the one it links to
      const h = f.getAttribute('href');
      if (!prims && h && h[0] === '#') w = filterWeight(byId.get(h.slice(1)));
      fweights.set(f, w);
      return w;
    }
    // what a filter value costs: url(#f) its filter, functions 1 to 5
    function chainWeight(v) {
      let w = 0;
      for (const m of String(v).matchAll(/([a-zA-Z-]+)\s*\(\s*(?:['"]?#([\w.:-]+))?/g)) {
        const f = m[1].toLowerCase();
        w += f === 'url' ? filterWeight(m[2] && byId.get(m[2])) : f === 'blur' ? 4 : f === 'drop-shadow' ? 5 : 1;
      }
      return w;
    }
    function weight(el) {
      let w = el.hasAttribute('filter') ? chainWeight(el.getAttribute('filter')) : 0;
      for (const d of String(el.getAttribute('style') || '').split(';')) {
        const m = FILTER_PROPS.exec(d);
        if (!m) continue;
        const v = d.slice(m[0].length);
        if (/^\s*none\s*$/i.test(v)) continue;
        // a shadow costs a blur each (a comma outside parentheses each)
        w += /shadow$/i.test(m[1]) ? 4 * (v.replace(/\([^)]*\)/g, '').split(',').length) : chainWeight(v);
      }
      return w;
    }
    // the copies of EL rendered: where it is in the tree, and uses of it
    const memo = new Map();
    function renders(el) {
      if (memo.has(el)) return memo.get(el);
      memo.set(el, 0);                    // limitUses dropped cycles
      const p = el.parentElement;
      let n = !p || p === root ? 1 : NOT_RENDERED.has(p.localName) ? viaUses(p) : renders(p);
      n += viaUses(el);
      memo.set(el, n);
      return n;
    }
    function viaUses(el) {
      let n = 0;
      for (const u of usesOf.get(el) || []) n += renders(u);
      return n;
    }
    function repainted(el) {
      for (let a = el.parentElement; a && a !== root; a = a.parentElement) if (REPAINTED.has(a.localName)) return true;
      return false;
    }
    let total = 0;
    for (const el of els) {
      if (!el.hasAttribute('filter') && !el.hasAttribute('style')) continue;
      const w = weight(el);
      if (!w) continue;
      const cost = repainted(el) ? Infinity : w * renders(el);
      if (total + cost <= FILTER_BUDGET) { total += cost; continue; }
      el.removeAttribute('filter');
      if (el.hasAttribute('style')) {
        const kept = el.getAttribute('style').split(';').filter(d => !FILTER_PROPS.test(d)).join(';');
        if (kept.trim()) el.setAttribute('style', kept); else el.removeAttribute('style');
      }
    }
  }

  // The markup with every attribute whose name starts with "on" renamed
  // data-nb-on...: an inert document is still one of the page's to
  // Chromium, which checks the page's CSP when the parser sets an event
  // handler attribute and logs the (correct) refusal as a console error.
  // rebuild() never copies such attributes, nor data-* ones; this only
  // keeps the console clean.  A linear scan of the tags as the HTML
  // tokenizer reads them (comments and CDATA skipped, quoted values with
  // their ">"): a tag it misreads only means a message in the console.
  const WSP = /[\s/]/, NAME_END = /[\s/>=]/, UNQUOTED_END = /[\s>]/, LETTER = /[A-Za-z]/, SPACE1 = /\s/;
  function defang(s) {
    if (!/on/i.test(s)) return s;
    const n = s.length;
    let out = '', from = 0, i = 0;
    for (;;) {
      const lt = s.indexOf('<', i);
      if (lt < 0) break;
      if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
      if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt + 9); i = e < 0 ? n : e + 3; continue; }
      if (!LETTER.test(s[lt + 1] || '')) { i = lt + 1; continue; }
      let j = lt + 1;
      while (j < n && !WSP.test(s[j]) && s[j] !== '>') j++;
      while (j < n && s[j] !== '>') {
        if (WSP.test(s[j])) { j++; continue; }
        const a = j;
        j++;                            // a name may start with "="
        while (j < n && !NAME_END.test(s[j])) j++;
        if ((s[a] === 'o' || s[a] === 'O') && (s[a + 1] === 'n' || s[a + 1] === 'N')) { out += s.slice(from, a) + 'data-nb-'; from = a; }
        while (j < n && SPACE1.test(s[j])) j++;
        if (s[j] !== '=') continue;
        j++;
        while (j < n && SPACE1.test(s[j])) j++;
        if (s[j] === '"' || s[j] === '\'') { const e = s.indexOf(s[j], j + 1); j = e < 0 ? n : e + 1; }
        else while (j < n && !UNQUOTED_END.test(s[j])) j++;
      }
      i = j + 1;
    }
    return out + s.slice(from);
  }

  function sanitizeMarkup(str, kind, idPrefix, doc) {
    doc = doc || document;
    const prefix = idPrefix || '';
    const frag = doc.createDocumentFragment();
    const P = new (doc.defaultView && doc.defaultView.DOMParser || DOMParser)();
    // as many elements from uses as the markup has characters
    const budget = Math.max(2000, String(str).length);
    str = defang(String(str));
    if (kind === 'svg') {
      const d = P.parseFromString(String(str), 'image/svg+xml');
      if (d.getElementsByTagName('parsererror').length || !d.documentElement || d.documentElement.namespaceURI !== SVG_NS)
        throw new Error('the SVG is not well-formed XML');
      const holder = doc.createElementNS(SVG_NS, 'g');
      const wrap = d.createElement('x');      // so that rebuild sees the root as a child
      wrap.appendChild(d.documentElement);
      rebuild(doc, wrap, holder, prefix, 0);
      limitUses(holder, budget);
      limitFilters(holder);
      while (holder.firstChild) frag.appendChild(holder.firstChild);
      return frag;
    }
    const d = P.parseFromString('<!doctype html><html><head></head><body>' + String(str), 'text/html');
    rebuild(doc, d.body, frag, prefix, 0);
    limitUses(frag, budget);
    limitFilters(frag);
    return frag;
  }

  // ---- Lua text scanning

  const NAME_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
  const IDENT = /[A-Za-z0-9_]/;
  const WS = /[ \t\r\n\f\v]/;
  const isAlpha = c => c === '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
  const isDigit = c => c >= '0' && c <= '9';

  // the level of the long bracket "[" "="* "[" at t[i], or -1
  function longLevel(t, i) {
    if (t[i] !== '[') return -1;
    let j = i + 1;
    while (t[j] === '=') j++;
    return t[j] === '[' ? j - i - 1 : -1;
  }
  // the index just past the closing bracket of the long bracket of LEVEL
  // opened at t[i], or -1 when it is not closed
  function longEnd(t, i, level) {
    const close = ']' + '='.repeat(level) + ']';
    const e = t.indexOf(close, i + level + 2);
    return e < 0 ? -1 : e + close.length;
  }
  // [end, closed] of the short string whose quote is t[i]: as llex reads
  // it, a backslash escapes the next character (a newline, \r\n
  // included), \z skips the white space after it, and an unescaped
  // newline ends the string unfinished (before the newline)
  function shortEnd(t, i) {
    const q = t[i], n = t.length;
    let j = i + 1;
    while (j < n) {
      const c = t[j];
      if (c === q) return [j + 1, true];
      if (c === '\\') {
        const d = t[j + 1];
        if (d === 'z') { j += 2; while (j < n && WS.test(t[j])) j++; continue; }
        j += (d === '\r' && t[j + 2] === '\n') || (d === '\n' && t[j + 2] === '\r') ? 3 : 2;
        continue;
      }
      if (c === '\n' || c === '\r') return [j, false];
      j++;
    }
    return [n, false];
  }
  // the end of the numeral at t[i], as llex's read_numeral takes it
  // (hex digits, dots and exponents with their sign), and the letters
  // that make it malformed
  function numberEnd(t, i) {
    const n = t.length;
    let j = i, expo = 'Ee';
    if (t[j] === '0' && (t[j + 1] === 'x' || t[j + 1] === 'X')) { j += 2; expo = 'Pp'; }
    while (j < n) {
      const c = t[j];
      if (expo.includes(c)) { j++; if (t[j] === '+' || t[j] === '-') j++; }
      else if (isDigit(c) || c === '.' || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) j++;
      else break;
    }
    while (j < n && IDENT.test(t[j])) j++;
    return j;
  }

  // What closes each opener.  Blocks are counted as lparser nests them:
  // "while ... do" and "for ... do" open at their do, "if" at the if
  // (elseif and else only continue it); "global function" opens at its
  // function, "global" itself never.
  const CLOSER_OF = { function: 'end', do: 'end', if: 'end', repeat: 'until', '(': ')', '[': ']', '{': '}' };

  // Calls f(kind, i[, depth]) for openers and closers outside strings and
  // comments ('open', 'close'), each comment ('comment', at its end) and
  // each newline outside them ('newline', with the depth after the line);
  // returns {depth, stray, mismatch, open, stack, strays, firstStray,
  // firstMismatch}: open is null, 'string', 'long string' or 'comment'
  // (the first construct left unfinished).  A closer of the wrong kind
  // closes all the same (counted in mismatch).
  function scan(text, f) {
    const t = String(text), n = t.length, stack = [], strays = new Map();
    let stray = 0, mismatch = 0, open = null, firstStray = null, firstMismatch = null;
    const close = (tok, i) => {
      if (!stack.length) {
        stray++;
        strays.set(tok, (strays.get(tok) || 0) + 1);
        if (!firstStray) firstStray = tok;
      } else if (CLOSER_OF[stack.pop()] !== tok) {
        mismatch++;
        if (!firstMismatch) firstMismatch = tok;
      }
      if (f) f('close', i);
    };
    let i = 0;
    while (i < n) {
      const c = t[i];
      if (c === '\n') { if (f) f('newline', i, stack.length); i++; continue; }
      if (c === '-' && t[i + 1] === '-') {
        const lv = longLevel(t, i + 2);
        if (lv >= 0) {
          const e = longEnd(t, i + 2, lv);
          if (e < 0) { open = open || 'comment'; i = n; } else i = e;
        } else {
          const e = t.indexOf('\n', i);
          i = e < 0 ? n : e;
        }
        if (f) f('comment', i);
        continue;
      }
      if (c === '[') {
        const lv = longLevel(t, i);
        if (lv >= 0) {
          const e = longEnd(t, i, lv);
          if (e < 0) { open = open || 'long string'; i = n; } else i = e;
          continue;
        }
      }
      if (c === '"' || c === '\'') {
        const [e, closed] = shortEnd(t, i);
        if (!closed) open = open || 'string';
        i = e;
        continue;
      }
      if (isDigit(c) || (c === '.' && isDigit(t[i + 1]))) { i = numberEnd(t, i); continue; }
      if (isAlpha(c)) {
        NAME_RE.lastIndex = i;
        const w = NAME_RE.exec(t)[0];
        if (w === 'function' || w === 'do' || w === 'if' || w === 'repeat') { stack.push(w); if (f) f('open', i); }
        else if (w === 'end' || w === 'until') close(w, i);
        i += w.length;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') { stack.push(c); if (f) f('open', i); }
      else if (c === ')' || c === ']' || c === '}') close(c, i);
      i++;
    }
    return { depth: stack.length, stray, mismatch, open, stack, strays, firstStray, firstMismatch };
  }

  // The balance badge of a code cell.  TEXT is what it says, '' when the
  // cell is balanced: "unfinished string", "1 extra end",
  // "1 mismatched )", "unclosed 'function'", "unclosed (", or with more
  // than one open "2 unclosed, innermost 'if'".
  function balance(text) {
    const s = scan(String(text == null ? '' : text));
    const top = s.depth ? s.stack[s.depth - 1] : null;
    let msg = '';
    if (s.open) msg = 'unfinished ' + s.open;
    else if (s.stray) msg = s.strays.get(s.firstStray) + ' extra ' + s.firstStray;
    else if (s.mismatch) msg = s.mismatch + ' mismatched ' + s.firstMismatch;
    else if (top) {
      const what = top.length === 1 ? top : '\'' + top + '\'';
      msg = (s.depth > 1 ? s.depth + ' unclosed, innermost ' : 'unclosed ') + what;
    }
    return { depth: s.depth, stray: s.stray, mismatch: s.mismatch, open: !!s.open, unclosed: top,
             ok: !s.depth && !s.stray && !s.mismatch && !s.open, text: msg };
  }

  // the line after LINE is indented one level more: LINE leaves a block
  // or bracket open, or is an else or an elseif
  function opensBlock(line) {
    const l = String(line), s = scan(l);
    if (s.open) return false;
    if (s.depth > 0) return true;
    return /^[ \t]*(?:else|elseif)(?![A-Za-z0-9_])/.test(l) && !s.stray;
  }

  // One string per blank-line separated group of lines, splitting only
  // at a blank line outside any block, bracket, long string or comment.
  // (Each line is looked at once: a big import stays linear.)
  function splitChunks(text) {
    const t = String(text).replace(/\r\n?/g, '\n');
    const out = [];
    let start = 0, lineStart = 0, content = false;
    scan(t, (kind, i, depth) => {
      if (kind !== 'newline' || depth) return;
      const isBlank = /^[ \t]*$/.test(t.slice(lineStart, i));
      if (isBlank && content) {
        out.push(t.slice(start, lineStart));
        start = i + 1;
        content = false;
      } else if (!isBlank) content = true;
      lineStart = i + 1;
    });
    const rest = t.slice(start);
    if (rest.trim()) out.push(rest);
    return out.map(trimBlankLines).filter(s => s.trim());
  }
  function trimBlankLines(s) { return s.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '').replace(/[ \t]+$/, ''); }

  // ---- Lua syntax highlighting

  const HIGHLIGHT_MAX = 32 * 1024;      // code colored per renderMarkdown()/colorCode(); the rest is left plain

  const RESERVED = new Set(('and break do else elseif end false for function goto if in local nil not or ' +
    'repeat return then true until while').split(' '));
  // the standard library's globals (and the notebook's), colored where
  // they are globals: not after "." or ":"
  const LIBRARY = new Set(('print pairs ipairs next select type tostring tonumber error assert pcall xpcall ' +
    'require load loadfile dofile rawget rawset rawequal rawlen setmetatable getmetatable collectgarbage warn ' +
    'string table math io os coroutine utf8 debug package _G _ENV _VERSION notebook').split(' '));
  // With LUA_COMPAT_GLOBAL (luaconf.h's default) "global" is a name to
  // the lexer, and lparser's statement() takes it as the declaration only
  // at the start of a statement, before a Name, "function", "<" or "*".
  // A statement starts after the end of another (or of an expression,
  // since Lua needs no ";") or at the start of a block: after one of
  // these tokens.
  const BEFORE_GLOBAL = new Set([';', ')', ']', '}', 'name', 'number', 'string', 'nil', 'true', 'false', '...',
                                 'end', 'break', 'label', 'attrib', 'do', 'then', 'else', 'repeat']);
  const LABEL_RE = /::[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*::/y;
  const ATTRIB_RE = /<[ \t]*(?:const|close)[ \t]*>/y;

  // the significant token at or after J (white space and comments
  // skipped): 'name' for a name that is not reserved, a reserved word, a
  // character, or null at the end
  function nextToken(t, j) {
    const n = t.length;
    for (;;) {
      while (j < n && WS.test(t[j])) j++;
      if (t[j] !== '-' || t[j + 1] !== '-') break;
      const lv = longLevel(t, j + 2);
      const e = lv >= 0 ? longEnd(t, j + 2, lv) : t.indexOf('\n', j);
      if (e < 0) return null;
      j = e;
    }
    if (j >= n) return null;
    if (!isAlpha(t[j])) return t[j];
    NAME_RE.lastIndex = j;
    const w = NAME_RE.exec(t)[0];
    return RESERVED.has(w) ? w : 'name';
  }
  const startsGlobal = tok => tok === 'name' || tok === 'function' || tok === '<' || tok === '*';

  // [kind, text] pieces whose texts add up to the Lua source, in linear
  // time.  Kinds: '' (white space, names, operators), comment, string,
  // number, special (reserved words, and "global" as a declaration),
  // constant (nil, true, false, ...), keyword (a library global), quote
  // (<const>, <close>, ::label::) and paren.  Unterminated long strings
  // and comments run to the end; a short string ends at an unescaped
  // newline, as llex reads it.
  function highlight(text) {
    const t = String(text), n = t.length, out = [];
    // prev: the previous significant token, as BEFORE_GLOBAL names them
    let i = 0, prev = null;
    const put = (k, j) => {
      const last = out[out.length - 1];
      if (last && last[0] === k) last[2] = j; else out.push([k, i, j]);
      i = j;
    };
    while (i < n) {
      const c = t[i];
      if (WS.test(c)) {
        let j = i + 1;
        while (j < n && WS.test(t[j])) j++;
        put('', j);
        continue;
      }
      if (c === '-' && t[i + 1] === '-') {
        const lv = longLevel(t, i + 2);
        const e = lv >= 0 ? longEnd(t, i + 2, lv) : t.indexOf('\n', i);
        put('comment', e < 0 ? n : e);
        continue;
      }
      if (c === '[') {
        const lv = longLevel(t, i);
        if (lv >= 0) {
          const e = longEnd(t, i, lv);
          put('string', e < 0 ? n : e);
          prev = 'string';
        } else { put('paren', i + 1); prev = c; }
        continue;
      }
      if (c === '"' || c === '\'') { put('string', shortEnd(t, i)[0]); prev = 'string'; continue; }
      if (isDigit(c) || (c === '.' && isDigit(t[i + 1]))) { put('number', numberEnd(t, i)); prev = 'number'; continue; }
      if (isAlpha(c)) {
        NAME_RE.lastIndex = i;
        const w = NAME_RE.exec(t)[0], j = i + w.length;
        let k = '';
        if (w === 'nil' || w === 'true' || w === 'false') { k = 'constant'; prev = w; }
        else if (RESERVED.has(w)) { k = 'special'; prev = w; }
        else if (w === 'global' && (prev === null || BEFORE_GLOBAL.has(prev)) && startsGlobal(nextToken(t, j))) {
          k = 'special';
          prev = 'global';
        } else {
          if (LIBRARY.has(w) && prev !== '.' && prev !== ':') k = 'keyword';
          prev = 'name';
        }
        put(k, j);
        continue;
      }
      if (c === ':' && t[i + 1] === ':') {
        LABEL_RE.lastIndex = i;
        const m = LABEL_RE.exec(t);
        if (m) { put('quote', i + m[0].length); prev = 'label'; continue; }
        put('', i + 2);
        prev = '::';
        continue;
      }
      if (c === '<' && (prev === 'name' || prev === 'global')) {
        ATTRIB_RE.lastIndex = i;
        const m = ATTRIB_RE.exec(t);
        if (m) { put('quote', i + m[0].length); prev = 'attrib'; continue; }
      }
      if (c === '.' && t[i + 1] === '.') {
        // "..." is a constant, ".." an operator (not a field access)
        if (t[i + 2] === '.') { put('constant', i + 3); prev = '...'; }
        else { put('', i + 2); prev = '..'; }
        continue;
      }
      if (c === '(' || c === ')' || c === ']' || c === '{' || c === '}') { put('paren', i + 1); prev = c; continue; }
      put('', i + 1);
      prev = c;
    }
    return out.map(([k, a, b]) => [k, t.slice(a, b)]);
  }

  // the pieces of highlight() line by line, without the newlines
  function highlightLines(pieces) {
    const lines = [[]];
    for (const [k, s] of pieces) {
      const parts = s.split('\n');
      parts.forEach((x, j) => { if (j) lines.push([]); if (x) lines[lines.length - 1].push([k, x]); });
    }
    return lines;
  }

  // highlight() as DOM: spans of class syn-KIND, text nodes for plain text
  function highlightDom(text, doc) {
    const frag = doc.createDocumentFragment();
    for (const [k, s] of highlight(String(text))) {
      if (!k) { frag.appendChild(doc.createTextNode(s)); continue; }
      const e = doc.createElement('span');
      e.className = 'syn-' + k;
      e.textContent = s;
      frag.appendChild(e);
    }
    return frag;
  }

  // colors the Lua code blocks of renderMarkdown(src, doc, prefix, ids,
  // true) under root, up to HIGHLIGHT_MAX characters in all
  function colorCode(root, doc) {
    let budget = HIGHLIGHT_MAX;
    for (const code of root.querySelectorAll('code[data-syn]')) {
      code.removeAttribute('data-syn');
      const text = code.textContent;
      if (text.length > budget) continue;
      budget -= text.length;
      code.replaceChildren(highlightDom(text, doc));
    }
  }

  // ---- smart quotes

  // Phone keyboards type curly quotes.  Outside strings and comments a
  // quote of either family becomes the straight one; a curly one opens a
  // string that the straight quote or any quote of its own family closes
  // (written straight), while a straight one opens a string in which
  // curly quotes are content.  Escapes are copied as they are (so an
  // escaped curly quote stays content), a newline ends a short string as
  // llex says, and long strings and comments are never changed.  The one
  // ambiguity: in a string opened with ‘ an apostrophe closes it.
  const DQ = '“”„‟″', SQ = '‘’‚‛′', CURLY = /[“”„‟″‘’‚‛′]/;
  function straightenQuotes(s) {
    const t = String(s == null ? '' : s), n = t.length;
    if (!CURLY.test(t)) return t;
    let out = '', from = 0, i = 0;
    const replace = (at, ch) => { out += t.slice(from, at) + ch; from = at + 1; };
    while (i < n) {
      const c = t[i];
      if (c === '-' && t[i + 1] === '-') {
        const lv = longLevel(t, i + 2);
        const e = lv >= 0 ? longEnd(t, i + 2, lv) : t.indexOf('\n', i);
        i = e < 0 ? n : e;
        continue;
      }
      if (c === '[') {
        const lv = longLevel(t, i);
        const e = lv >= 0 ? longEnd(t, i, lv) : i + 1;
        i = e < 0 ? n : e;
        continue;
      }
      let fam = '', curly = false;
      if (c === '"' || DQ.includes(c)) fam = '"';
      else if (c === '\'' || SQ.includes(c)) fam = '\'';
      if (!fam) { i++; continue; }
      curly = c !== fam;
      const same = fam === '"' ? DQ : SQ;
      if (curly) replace(i, fam);
      for (i++; i < n; i++) {
        const d = t[i];
        if (d === '\\') {
          if (t[i + 1] === 'z') { i += 2; while (i < n && WS.test(t[i])) i++; i--; }
          else i++;
          continue;
        }
        if (d === '\n' || d === '\r') break;
        if (d === fam) { i++; break; }
        if (curly && same.includes(d)) { replace(i, fam); i++; break; }
      }
    }
    return out + t.slice(from);
  }

  // ---- ids

  let idSeq = 0;
  function newId() {
    let r = '';
    try {
      const b = new Uint8Array(6);
      (globalThis.crypto || self.crypto).getRandomValues(b);
      for (const x of b) r += (x % 36).toString(36);
    } catch (e) { r = Math.random().toString(36).slice(2, 8); }
    return 'c' + r + (++idSeq).toString(36);
  }
  const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

  // ---- .lua percent format (as jupytext writes Lua)

  const MARK = /^--\s?%%(.*)$/;
  // a line of a cell that would read as a marker, or as such a line
  // escaped, is written with one more backslash after the "--"
  const escapeMark = l => l.replace(/^(--\s?)(\\*%%)/, '$1\\$2');
  const unescapeMark = l => l.replace(/^(--\s?)\\(\\*%%)/, '$1$2');
  const HEAD_MODE = '-- -*- mode: lua -*-';
  const HEAD_TITLE = /^-- Lua notebook: (.*)$/;
  const HEAD_NOTE = '-- Exported from the Lua notebook: a bare expression at the end of a cell, and notebook.*, ' +
                    'work only there.';
  const isHeadLine = l => l === HEAD_MODE || HEAD_TITLE.test(l) || l === HEAD_NOTE;

  function splitPercent(text) {
    const lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
    let title = '';
    if (!lines.some(l => MARK.test(l))) {
      const chunks = splitChunks(lines.join('\n'));
      // a leading notebook header is not a cell
      if (chunks.length) {
        const head = chunks[0].split('\n');
        const t = head.map(l => HEAD_TITLE.exec(l)).find(Boolean);
        if (t && head.every(l => l.startsWith('--'))) {
          title = t[1].trim();
          const rest = trimBlankLines(head.filter(l => !isHeadLine(l)).join('\n'));
          if (rest.trim()) chunks[0] = rest; else chunks.shift();
        }
      }
      return { title, cells: chunks.map(c => ({ id: newId(), type: 'code', source: c })) };
    }
    const cells = [], pre = [];
    let cur = null;
    const close = () => {
      if (!cur) return;
      let src = cur.lines;
      if (cur.type === 'markdown') src = src.map(l => l.replace(/^-- ?/, ''));
      cur.source = trimBlankLines(src.join('\n'));
      delete cur.lines;
      cells.push(cur);
    };
    for (const l of lines) {
      const m = MARK.exec(l);
      if (m) {
        close();
        cur = { id: newId(), type: /\[\s*markdown\s*\]/i.test(m[1]) ? 'markdown' : 'code', lines: [] };
        continue;
      }
      if (cur) cur.lines.push(unescapeMark(l)); else pre.push(l);
    }
    close();
    const mt = pre.map(l => HEAD_TITLE.exec(l)).find(Boolean);
    if (mt) title = mt[1].trim();
    const rest = trimBlankLines(pre.filter(l => !isHeadLine(l)).join('\n'));
    if (rest.trim()) cells.unshift({ id: newId(), type: 'code', source: rest });
    return { title, cells };
  }

  function toPercent(nb) {
    const out = [HEAD_MODE, '-- Lua notebook: ' + String(nb.title || 'Untitled').replace(/[\r\n]+/g, ' '), HEAD_NOTE, ''];
    for (const c of nb.cells) {
      if (c.type === 'markdown') {
        out.push('-- %% [markdown]');
        for (const l of String(c.source).split('\n')) out.push(l ? escapeMark('-- ' + l) : '--');
      } else {
        out.push('-- %%');
        out.push(String(c.source).split('\n').map(escapeMark).join('\n'));
      }
      out.push('');
    }
    return out.join('\n');
  }

  // ---- JSON format

  const MIMES = new Set(['text/plain', 'text/html', 'image/svg+xml', 'text/markdown',
                         'image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  // what Import accepts; a cell may be as large as the file (and keeps
  // at most OUTPUTS outputs, see limitOutputs)
  const LIMITS = { file: 5 * 1024 * 1024, cells: 5000, source: 5 * 1024 * 1024, outputs: 1000 };
  const NO_LIMITS = { file: Infinity, cells: Infinity, source: Infinity, outputs: Infinity };
  const str = (x, max) => typeof x === 'string' && x.length <= (max || Infinity);
  const strOrNull = x => (x === null || x === undefined ? null : typeof x === 'string' ? x.slice(0, 4096) : null);

  // the kernel's ErrorObj (text, kind, line, chain [{where, proc}], form,
  // traceback), as far as it is well-formed
  function cleanError(e) {
    if (!e || typeof e !== 'object' || typeof e.text !== 'string') return null;
    const chain = Array.isArray(e.chain) ? e.chain.slice(0, 200).filter(f => f && typeof f === 'object' && typeof f.where === 'string')
      .map(f => ({ where: f.where.slice(0, 200), proc: strOrNull(f.proc) })) : [];
    return {
      text: e.text.slice(0, 65536),
      kind: Array.isArray(e.kind) ? e.kind.filter(k => typeof k === 'string').slice(0, 16).map(k => k.slice(0, 64)) : [],
      line: Number.isInteger(e.line) && e.line > 0 ? e.line : null,
      chain,
      form: e.form === 'print' ? 'print' : null,
      traceback: typeof e.traceback === 'string' ? e.traceback.slice(0, 65536) : null,
    };
  }
  function cleanOutput(o) {
    if (!o || typeof o !== 'object') return null;
    switch (o.k) {
    case 'stream':
      return (o.name === 'stdout' || o.name === 'stderr' || o.name === 'stdin') && str(o.text)
        ? { k: 'stream', name: o.name, text: o.text } : null;
    case 'value':
      return str(o.text) ? { k: 'value', text: o.text } : null;
    case 'note':
      return str(o.text, 4096) ? Object.assign({ k: 'note', text: o.text }, o.bad === true ? { bad: true } : {}) : null;
    case 'display':
      return MIMES.has(o.mime) && str(o.data)
        ? { k: 'display', mime: o.mime, data: o.data, id: typeof o.id === 'string' ? o.id.slice(0, 256) : null } : null;
    case 'error': { const e = cleanError(o.error); return e ? { k: 'error', error: e } : null; }
    default: return null;
    }
  }
  function cleanDate(x) { return typeof x === 'string' && x.length < 40 && !isNaN(Date.parse(x)) ? x : null; }

  // a code cell's status is saved when it did not succeed
  const FAILED = new Set(['error', 'interrupted']);

  function toJson(nb) {
    return JSON.stringify({
      format: 'lua-notebook',
      version: 1,
      meta: { title: nb.title || 'Untitled', created: nb.created || null, modified: nb.modified || null,
              lua: nb.lua || null, arch: nb.arch || null },
      cells: nb.cells.map(c => {
        const o = { id: c.id, type: c.type, source: c.source };
        if (c.type === 'code' && Number.isInteger(c.count)) o.count = c.count;
        if (c.type === 'code' && FAILED.has(c.status)) o.status = c.status;
        if (c.outputs && c.outputs.length) o.outputs = c.outputs;
        return o;
      }),
    });
  }

  // At most MAX outputs: the first ones, a note saying how many were
  // left out, and the last one (which may be the error that ended the
  // cell).  OUTS itself when it has no more.
  function limitOutputs(outs, max) {
    if (!Array.isArray(outs) || outs.length <= max) return outs;
    if (max < 3) return outs.slice(0, max);
    const omitted = outs.length - (max - 1);
    return outs.slice(0, max - 2).concat([{ k: 'note', text: '… ' + omitted + ' outputs were left out' }],
                                         outs.slice(-1));
  }

  // OPTS.limits false: no limits, for what the page saved itself
  function fromJson(text, opts) {
    const lim = opts && opts.limits === false ? NO_LIMITS : LIMITS;
    if (typeof text !== 'string') throw new Error('not a notebook');
    if (text.length > lim.file) throw new Error('the file is larger than 5 MB');
    let j;
    try { j = JSON.parse(text); } catch (e) { throw new Error('not valid JSON: ' + e.message); }
    if (!j || typeof j !== 'object' || j.format !== 'lua-notebook' || !Array.isArray(j.cells))
      throw new Error('not a Lua notebook (format "lua-notebook" expected)');
    if (j.version !== 1)
      throw new Error('unsupported notebook version ' + JSON.stringify(j.version === undefined ? null : j.version) +
                      ' (version 1 expected)');
    if (j.cells.length > lim.cells) throw new Error('more than ' + lim.cells + ' cells');
    const warnings = [];
    const meta = j.meta && typeof j.meta === 'object' ? j.meta : {};
    const seen = new Set();
    const cells = [];
    let dropped = 0, cut = 0;
    for (const c of j.cells) {
      if (!c || typeof c !== 'object' || (c.type !== 'code' && c.type !== 'markdown') || !str(c.source, lim.source)) { dropped++; continue; }
      let id = typeof c.id === 'string' && ID_RE.test(c.id) && !seen.has(c.id) ? c.id : newId();
      while (seen.has(id)) id = newId();
      seen.add(id);
      const cell = { id, type: c.type, source: c.source };
      if (c.type === 'code' && Number.isInteger(c.count) && c.count > 0 && c.count < 1e9) cell.count = c.count;
      if (c.type === 'code' && FAILED.has(c.status)) cell.status = c.status;
      if (Array.isArray(c.outputs)) {
        const all = c.outputs.map(cleanOutput).filter(Boolean);
        const outs = limitOutputs(all, lim.outputs);
        if (outs !== all) cut++;
        if (outs.length) cell.outputs = outs;
      }
      cells.push(cell);
    }
    if (dropped) warnings.push(dropped + ' invalid cell' + (dropped > 1 ? 's were' : ' was') + ' skipped.');
    if (cut) warnings.push(cut + (cut > 1 ? ' cells had' : ' cell had') + ' more than ' + lim.outputs +
                           ' outputs, so some were left out.');
    return {
      title: typeof meta.title === 'string' ? meta.title.slice(0, 200) : '',
      created: cleanDate(meta.created), modified: cleanDate(meta.modified),
      cells, warnings,
    };
  }

  return { renderMarkdown, sanitizeMarkup, splitPercent, toPercent, toJson, fromJson, balance, opensBlock,
           splitChunks, scan, highlight, highlightLines, highlightDom, colorCode, straightenQuotes, newId,
           safeHref, safeImageSrc, slug, LIMITS, limitOutputs };
});
