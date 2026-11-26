/*
 * fill-core.js - fills the "Detailed description" of every language on the
 * Chrome Web Store dashboard "Store listing" tab. Used by `ext-localize push chrome`
 * (paste script) and `ext-localize push chrome --auto` (DevTools Protocol).
 *
 * Copied from an earlier prototype (the fixed version:
 * the language dropdown is matched by data-value, and the trigger text is checked with
 * "contains", because the real dashboard adds icon text like "arrow_drop_down").
 *
 * Plain browser JavaScript, no build step. It sets `globalThis.ListingFill`.
 *
 * Rules it follows:
 *   - Find elements by role/label first, CSS selectors second.
 *   - Fail loudly when a lookup finds 0 or more than 1 element.
 *   - Read the language list from the live dropdown; report locales it cannot match.
 *     Only two code rewrites: "_" -> "-" and "he" -> "iw".
 *   - Wait for the page to settle after a language switch before writing.
 *   - After filling, walk all languages again and compare what the page holds to the file.
 *   - Never clicks "Submit for review" / "Publish". "Save draft" only if the caller asks.
 */
(function (root) {
  'use strict';

  const VERSION = '0.3.0';
  const MAX_LEN = 16000; // dashboard limit for the detailed description (from LocalePack's selector; not in Google docs)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n');
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  // Chrome _locales code -> dashboard code.  pt_BR -> pt-BR, he -> iw.
  function toDashboardCode(locale) {
    let c = String(locale).replace(/_/g, '-');
    if (c === 'he' || c.startsWith('he-')) c = 'iw' + c.slice(2);
    return c;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  // Small accessible-name helper (not the full spec; enough for labels/aria).
  function accName(el) {
    if (!el) return '';
    const al = el.getAttribute('aria-label');
    if (al) return clean(al);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.textContent).join(' ');
      if (clean(t)) return clean(t);
    }
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) return clean(lab.textContent);
    }
    const wrap = el.closest('label');
    if (wrap) return clean(wrap.textContent);
    return '';
  }

  // Try strategies in order. The first strategy that finds anything wins.
  // 0 matches overall, or >1 match in the winning strategy -> throw.
  function findOne(what, strategies) {
    for (const [how, fn] of strategies) {
      let found;
      try { found = Array.from(new Set(fn())).filter(isVisible); } catch (e) { found = []; }
      if (found.length === 1) return { el: found[0], how };
      if (found.length > 1) throw new Error('More than one match for ' + what + ' (strategy "' + how + '", ' + found.length + ' matches). Selectors need an update.');
    }
    throw new Error('Not found: ' + what + '. The dashboard markup may have changed.');
  }
  function tryFindOne(what, strategies) {
    try { return findOne(what, strategies); } catch (e) { return null; }
  }

  const $$ = (sel, r) => Array.from((r || document).querySelectorAll(sel));

  function findTrigger() {
    return findOne('language dropdown ("Current editing language")', [
      ['role=combobox + label', () => $$('[role=combobox]').filter((e) => /editing language|^language$/i.test(accName(e)))],
      ['text label + button', () => {
        const labels = $$('label, span, div, p').filter((e) => e.children.length === 0 && /^current editing language$/i.test(clean(e.textContent)));
        const out = [];
        for (const lab of labels) {
          const box = lab.parentElement;
          if (box) out.push(...$$('[role=button], [role=combobox], [aria-haspopup], button, select', box));
        }
        return out;
      }],
    ]);
  }

  function findList() {
    return tryFindOne('language list', [
      ['role=listbox named Language', () => $$('[role=listbox]').filter((e) => /^language$/i.test(accName(e)))],
      ["css ul[aria-label='Language']", () => $$("ul[aria-label='Language']")],
    ]);
  }

  function findTextarea() {
    return findOne('description textarea', [
      ['textarea labelled "description"', () => $$('textarea').filter((e) => /description/i.test(accName(e)))],
      ["css textarea[maxlength='16000']", () => $$("textarea[maxlength='16000']")],
    ]);
  }

  function findSaveDraft() {
    const r = findOne('"Save draft" button', [
      ['button named Save draft', () => $$('button, [role=button]').filter((e) => /^save draft$/i.test(clean(e.textContent) || accName(e)))],
    ]);
    if (/submit|publish|review/i.test(clean(r.el.textContent))) throw new Error('Refusing: save button text looks like submit/publish.');
    return r.el;
  }

  // Full pointer/mouse sequence. Some UI kits open on mousedown, others on click.
  function realClick(el) {
    const o = { bubbles: true, cancelable: true, view: window, button: 0 };
    if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  async function waitFor(fn, what, timeout) {
    const end = Date.now() + (timeout || 8000);
    for (;;) {
      let v;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() > end) throw new Error('Timed out waiting for ' + what);
      await sleep(50);
    }
  }

  // Resolve when the DOM has had no mutations for `quietMs`.
  function waitQuiet(quietMs, timeout) {
    quietMs = quietMs || 250;
    return new Promise((resolve) => {
      let t;
      const done = () => { obs.disconnect(); clearTimeout(cap); resolve(); };
      const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, quietMs); });
      obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      t = setTimeout(done, quietMs);
      const cap = setTimeout(done, timeout || 8000);
    });
  }

  // Names the dashboard may show for a code, e.g. pt-BR -> "Portuguese (Brazil)" / "Brazilian Portuguese".
  function displayNames(code) {
    const out = new Set();
    for (const languageDisplay of ['standard', 'dialect']) {
      try {
        const dn = new Intl.DisplayNames(['en'], { type: 'language', languageDisplay });
        out.add(dn.of(code).toLowerCase());
      } catch (e) { /* unknown code */ }
    }
    return out;
  }

  function optionInfo(opt) {
    return { el: opt, value: opt.getAttribute('data-value'), text: clean(opt.textContent) };
  }

  function matchOption(locale, options) {
    const code = toDashboardCode(locale).toLowerCase();
    const withValue = options.filter((o) => o.value);
    if (withValue.length) {
      const m = withValue.filter((o) => o.value.toLowerCase() === code);
      return m.length === 1 ? { opt: m[0], how: 'data-value' } : null;
    }
    // No codes in the markup: match on visible name, or a "(pt-BR)" style code in the text.
    const names = displayNames(code);
    const m = options.filter((o) => {
      const t = o.text.toLowerCase();
      return names.has(t) || t.includes('(' + code + ')') || t.endsWith(' ' + code) || t.endsWith(' - ' + code);
    });
    return m.length === 1 ? { opt: m[0], how: 'visible name' } : null;
  }

  function closeList() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    realClick(document.body);
  }

  async function listDashboardLanguages() {
    const trig = findTrigger().el;
    if (!findList()) realClick(trig);
    const list = await waitFor(findList, 'language list to open');
    const opts = $$('[role=option], li', list.el).map(optionInfo);
    closeList();
    await waitQuiet(100);
    return opts.map((o) => ({ value: o.value, text: o.text }));
  }

  // Does the closed dropdown show this option? The real dashboard puts extra text in the trigger
  // (Material icon names like "arrow_drop_down" are text ligatures), so test "contains", not "equals".
  // Fallback: the language code as a whole word, e.g. "en" in "English - en (default)".
  function triggerShows(opt) {
    const t = clean(findTrigger().el.textContent);
    if (opt.text && t.includes(opt.text)) return true;
    if (!opt.value) return false;
    const esc = opt.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^\\w-])' + esc + '($|[^\\w-])', 'i').test(t);
  }

  async function selectLocale(locale) {
    const trig = findTrigger().el;
    if (!findList()) realClick(trig);
    const list = await waitFor(findList, 'language list to open');
    const options = $$('[role=option], li', list.el).map(optionInfo);
    const m = matchOption(locale, options);
    if (!m) {
      closeList();
      await waitQuiet(100);
      return { ok: false, reason: 'no matching language in dropdown', available: options.map((o) => o.value || o.text) };
    }
    const wanted = m.opt.text;
    if (triggerShows(m.opt)) {
      closeList();
      await waitQuiet(100);
      return { ok: true, how: m.how, already: true };
    }
    realClick(m.opt.el);
    // Settle: trigger shows the new language, nothing is busy, the textarea is back, DOM is quiet.
    try {
      await waitFor(() => triggerShows(m.opt), 'dropdown to show ' + wanted);
    } catch (e) {
      let now = '?';
      try { now = clean(findTrigger().el.textContent); } catch (e2) { /* trigger gone */ }
      throw new Error(e.message + ' (dropdown text now: "' + now.slice(0, 80) + '")');
    }
    await waitFor(() => !document.querySelector('[aria-busy=true]') && findTextarea(), 'description box for ' + wanted);
    await waitQuiet(200);
    return { ok: true, how: m.how };
  }

  // The important part: React tracks the last value it saw. A plain `el.value = x`
  // updates React's tracker too, so the 'input' event looks like "no change" and the
  // text is lost on the next render. Calling the native prototype setter skips the tracker.
  function setText(el, text, naive) {
    el.focus();
    if (naive) {
      el.value = text;
    } else {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  function waitForUserSave(log, timeout) {
    return new Promise((resolve, reject) => {
      const onClick = (e) => {
        const b = e.target.closest && e.target.closest('button, [role=button]');
        if (b && /^save draft$/i.test(clean(b.textContent))) { cleanup(); resolve(); }
      };
      const cleanup = () => { document.removeEventListener('click', onClick, true); clearTimeout(t); };
      document.addEventListener('click', onClick, true);
      const t = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for you to click Save draft')); }, timeout || 10 * 60 * 1000);
      log('Check the text, then click "Save draft". I will continue after that.');
    });
  }

  // Code points, as the CLI counts them ([...s].length), not UTF-16 units.
  const cpLen = (s) => Array.from(String(s)).length;

  // First 12 hex digits of SHA-256 over the UTF-8 bytes. Same as the CLI:
  // createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
  async function shortHash(s) {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (!c || !c.subtle || typeof TextEncoder !== 'function') return null;
    const buf = await c.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  }

  /**
   * Does each embedded description still match what the CLI computed from the
   * listing file (length in code points + short hash)? A mismatch means the script
   * was damaged on the way (for example a clipboard that changed the encoding).
   * Entries without "length"/"sha" are not checked.
   */
  async function checkIntegrity(listings) {
    const problems = [];
    for (const loc of Object.keys(listings).sort()) {
      const e = listings[loc] || {};
      if (e.length == null && !e.sha) continue;
      const text = norm(e.description);
      const length = cpLen(text);
      const sha = await shortHash(text);
      if (e.length != null && length !== e.length) problems.push({ locale: loc, error: 'embedded text has ' + length + ' characters, the listing file has ' + e.length });
      else if (e.sha && sha && sha !== e.sha) problems.push({ locale: loc, error: 'embedded text hash ' + sha + ' differs from the listing file hash ' + e.sha });
    }
    return problems;
  }

  /** Compare page text with the expected length and hash. Returns null when it matches. */
  async function compareExpected(got, e) {
    if (!e || (e.length == null && !e.sha)) return null;
    const length = cpLen(got);
    if (e.length != null && length !== e.length) return 'page has ' + length + ' characters, expected ' + e.length;
    const sha = await shortHash(got);
    if (e.sha && sha && sha !== e.sha) return 'page text hash ' + sha + ', expected ' + e.sha;
    return null;
  }

  /**
   * listings: { "pt_BR": { description: "...", length: 123, sha: "0123abcd4567" }, ... }
   * length (code points) and sha (12 hex digits of SHA-256) are optional. When given,
   * nothing is filled unless every embedded text matches them, and the verify pass
   * checks the page text against them too.
   * opts:
   *   mode: 'fill-all'  fill every language, then one Save at the end (works if the dashboard keeps unsaved text)
   *         'save-each' save after each language (needed if the dashboard drops unsaved text on switch)
   *   save: 'none' (default) | 'wait' (wait for the user to click Save draft) | 'auto' (click Save draft; never submit)
   *   verify: true (default) walk all languages again and compare
   *   naive: true  use plain `el.value =` (only to prove the mock is hostile)
   *   log: function
   */
  async function run(listings, opts) {
    opts = Object.assign({ mode: 'fill-all', save: 'none', verify: true, naive: false }, opts || {});
    const log = opts.log || ((...a) => console.log('[listing-fill]', ...a));
    const report = { version: VERSION, mode: opts.mode, save: opts.save, integrity: null, filled: [], unmatched: [], tooLong: [], errors: [], verify: null, hint: null };

    // Refuse to fill anything when the script itself was damaged.
    const damaged = await checkIntegrity(listings);
    report.integrity = { ok: damaged.length === 0, problems: damaged };
    if (damaged.length) {
      report.errors.push(...damaged);
      report.hint = 'The text inside this script does not match the listing files. Nothing was filled. Rebuild the script with ext-localize and paste the file again.';
      log('STOP: the script text was damaged on the way. Nothing was filled.');
      log('Report:', JSON.stringify(report, null, 2));
      return report;
    }

    const locales = Object.keys(listings).sort();
    for (const loc of locales) {
      const text = norm(listings[loc] && listings[loc].description);
      if (!text) { report.errors.push({ locale: loc, error: 'empty description' }); continue; }
      if (text.length > MAX_LEN) { report.tooLong.push({ locale: loc, length: text.length }); continue; }
      try {
        const sel = await selectLocale(loc);
        if (!sel.ok) { report.unmatched.push({ locale: loc, dashboardCode: toDashboardCode(loc), available: sel.available }); log('No dashboard language for', loc); continue; }
        const ta = findTextarea();
        setText(ta.el, text, opts.naive);
        await waitQuiet(150);
        const now = norm(findTextarea().el.value);
        const want = listings[loc].length != null ? listings[loc].length : cpLen(text);
        const wrong = await compareExpected(now, listings[loc]);
        report.filled.push({ locale: loc, length: cpLen(now), wantLength: want, sha: await shortHash(now), matchedBy: sel.how, textareaBy: ta.how, readBackOk: now === text && !wrong });
        log('Filled', loc, '(' + cpLen(now) + ' of ' + want + ' characters)');
        if (opts.mode === 'save-each') {
          if (opts.save === 'auto') { realClick(findSaveDraft()); await waitQuiet(300); }
          else if (opts.save === 'wait') await waitForUserSave(log, opts.waitTimeoutMs);
        }
      } catch (e) {
        report.errors.push({ locale: loc, error: e.message });
        log('Error for', loc + ':', e.message);
        if (/Selectors need an update|markup may have changed/.test(e.message)) break; // stop early, do not guess
      }
    }

    if (opts.verify && report.filled.length) {
      const mismatches = [];
      for (const f of report.filled) {
        try {
          const sel = await selectLocale(f.locale);
          const got = sel.ok ? norm(findTextarea().el.value) : null;
          const want = norm(listings[f.locale].description);
          const wantLength = listings[f.locale].length != null ? listings[f.locale].length : cpLen(want);
          const wrong = got == null ? 'language not in dropdown' : await compareExpected(got, listings[f.locale]);
          if (got !== want || wrong) mismatches.push({ locale: f.locale, gotLength: got == null ? null : cpLen(got), wantLength, error: wrong || undefined });
        } catch (e) {
          mismatches.push({ locale: f.locale, error: e.message });
        }
      }
      report.verify = { ok: mismatches.length === 0, mismatches };
      if (mismatches.length && opts.mode === 'fill-all') {
        report.hint = 'Text was lost after switching language. The dashboard probably drops unsaved text. Run again with mode "save-each".';
      }
    }

    if (opts.mode === 'fill-all' && report.filled.length) {
      if (opts.save === 'auto') { realClick(findSaveDraft()); await waitQuiet(300); log('Clicked Save draft.'); }
      else log('Done. Review the languages, then click "Save draft" yourself.');
    }
    log('Report:', JSON.stringify(report, null, 2));
    return report;
  }

  root.ListingFill = { VERSION, MAX_LEN, run, toDashboardCode, selectLocale, listDashboardLanguages, findTextarea, setText, checkIntegrity, shortHash };
})(typeof globalThis !== 'undefined' ? globalThis : window);
