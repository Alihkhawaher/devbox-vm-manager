/*
 * devbox VM Manager - the browser GUI (spec section 14).
 *
 * Plain script, no framework and no build step. index.html loads it with
 * `defer` after the vendored xterm.js, so the DOM is ready when it runs.
 *
 * SAFETY (SEC-7, SEC-14, UI-1, UI-14, UI-19)
 *   Nothing that comes from the manager, a VM, a container or an image is
 *   ever parsed as HTML. Every dynamic node is built with h(), which puts text
 *   in text nodes and values in properties/attributes; this file never
 *   assigns HTML strings. A malicious image VOLUME, docker network name or task title
 *   is therefore just text on the page. Links are only ever built for
 *   http://127.0.0.1:<port> or a LAN address the manager reported, from
 *   integer ports. The page's CSP (script-src 'self') is the second line of
 *   defence; this file therefore has no inline handlers anywhere either.
 *   No native browser dialogs or pop-up windows: dialogs are the in-app modal.
 *
 * ACCESS TOKEN
 *   The manager prints http://127.0.0.1:<port>/#token=<token>. The token is
 *   taken from the fragment, kept in localStorage and the fragment is removed
 *   from the address bar. Every /api call sends it as X-DevBox-Token; the
 *   terminal stream (EventSource cannot set headers) passes ?token=. A 401
 *   shows the "Access token needed" screen instead of a broken page.
 *
 * ONE POLLING LOOP (UI-9, OPS-5)
 *   poll() fetches /api/state, renders, then schedules itself again with
 *   setTimeout - never two requests at once, nothing while the tab is hidden.
 *   Rendering diffs: rows and fields are updated in place and a form control
 *   the user is editing is never rebuilt or overwritten (UI-2, UI-8, UI-11).
 *
 * TASKS (UI-7, UI-20)
 *   Long operations answer 202 {task}; runTask() follows that task by its id
 *   until it is done or failed (fast tasks included), toasts the outcome and
 *   resolves with the final task, whose result may carry app URLs. The task
 *   center lists every running task and the recent ones, each with its log.
 *
 * DOCKER IMAGES WITHOUT DOCKER (microVM spec section 12, shares spec 6)
 *   "Run a Docker image" posts /api/container/run (engine auto|microvm): each
 *   image becomes its own microVM "container". Only an explicit "Docker inside
 *   a VM" choice, or privileged / host network (which a microVM cannot give),
 *   goes to the proven /api/vm/quickdeploy route directly. /api/state carries
 *   the container summaries, so the Containers table rides on the one polling
 *   loop; the detail panel, images, volumes and shared-folder status are
 *   fetched only while they are open. Container logs follow over Server-Sent
 *   Events (?token=, like the terminals) and are ALWAYS plain text: whatever
 *   runs in a container is untrusted. Routes that answer 501 (a manager built
 *   before the engine work) show "not available yet" instead of an error storm.
 *   Folder pickers use GET /api/fs/dirs inside the in-app modal.
 *
 * ROOT FILESYSTEM AND LIGHT PROFILE (SPEC-diskroot sections 9-11)
 *   A container's root filesystem is "disk" (the default: a read-only image
 *   disk shared per image plus the container's own writable layer, ~128 MB of
 *   RAM whatever the image) or "ram" (opt-in: the whole image in memory,
 *   reset at every start). The run form (Advanced), the container Settings
 *   tab (applies at the next start) and the gear dialog (the default) set
 *   it; rows show a Disk / RAM badge; a stopped disk-root container can
 *   "Start fresh" (POST /api/container/start {fresh:true}). The gear dialog
 *   also holds the light profile and the engine settings of config.json
 *   (POST /api/settings; blank = the profile's default) and, without
 *   hardware acceleration, the manager's accelHint (how to turn on nested
 *   virtualization) - text only, commands in <code>.
 */
(function () {
  'use strict';

  // ===========================================================================
  // DOM helpers
  // ===========================================================================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // h('button', {class: 'sm', type: 'button', onclick: fn}, 'label', child, [more])
  // Text arguments become text nodes, so server strings can never turn into markup.
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'data') { for (const d of Object.keys(v)) el.dataset[d] = String(v[d]); }
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = String(v);
        else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'open') el[k] = true;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c === undefined || c === null || c === false) return;
    if (Array.isArray(c)) { for (const x of c) append(el, x); return; }
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  function setChildren(el) {
    el.textContent = '';
    for (let i = 1; i < arguments.length; i++) append(el, arguments[i]);
  }
  function setText(el, s) {
    s = s === undefined || s === null ? '' : String(s);
    if (el.textContent !== s) el.textContent = s;
  }
  function field(id, label, input) {
    return h('div', { class: 'field' }, h('label', { for: id }, label), input);
  }
  function btn(label, cls, opts) {
    opts = opts || {};
    return h('button', {
      type: 'button', class: cls || 'sm', disabled: !!opts.disabled, 'aria-label': opts.aria,
      data: opts.fk ? { fk: opts.fk } : null,
      onclick: opts.onClick ? (e) => opts.onClick(e.currentTarget) : null,
    }, label);
  }

  // Run fn (which may rebuild part of the page) without losing keyboard focus:
  // a rebuilt button with the same data-fk key gets the focus back (UI-11).
  function keepFocusIn(box, fn) {
    const a = document.activeElement;
    const fk = a && box.contains(a) && a.dataset ? a.dataset.fk : null;
    fn();
    if (fk && !box.contains(document.activeElement)) {
      const el = $$('[data-fk]', box).find((x) => x.dataset.fk === fk);
      if (el && !el.disabled) { try { el.focus({ preventScroll: true }); } catch (e) { /* not focusable */ } }
    }
  }
  // Moving nodes (reordering) drops focus in some browsers: restore it.
  function keepFocus(fn) {
    const a = document.activeElement;
    fn();
    if (a && a !== document.body && document.contains(a) && document.activeElement !== a) {
      try { a.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }
  function selectionIn(el) {
    const s = window.getSelection ? window.getSelection() : null;
    return !!(s && s.rangeCount && !s.isCollapsed && el.contains(s.anchorNode));
  }
  function showErr(el, msg, focusEl) {
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg;
    el.hidden = false;
    if (focusEl) focusEl.focus();
  }
  const hideErr = (el) => showErr(el, null);

  // ===========================================================================
  // formatting and validation
  // ===========================================================================
  function fmtBytes(n) {
    if (n === null || n === undefined || !isFinite(n)) return '-';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i];
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec));
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
    return Math.floor(sec / 86400) + 'd ' + Math.floor((sec % 86400) / 3600) + 'h';
  }
  function secondsSince(t) {
    const ms = typeof t === 'number' ? t : Date.parse(t);
    return isFinite(ms) ? (Date.now() - ms) / 1000 : null;
  }
  function ago(t) {
    const s = secondsSince(t);
    if (s === null) return '';
    return s < 5 ? 'just now' : fmtDur(s) + ' ago';
  }
  function fmtDate(t) {
    const d = new Date(t);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
  }
  const firstLine = (s) => String(s || '').split('\n')[0];
  const pct = (a, b) => (b ? Math.min(100, Math.max(0, Math.round(a / b * 100))) : 0);
  function toInt(v) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!/^-?\d+$/.test(s)) return null;
    return parseInt(s, 10);
  }
  const isPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;

  // Mirrors of the manager's own rules (lib/util.js), only to answer faster
  // and keep the user's input in place; the manager stays the authority.
  const RE = {
    vm: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/,
    container: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,
    image: /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/,
    compose: /^[a-z0-9][a-z0-9_-]{0,62}$/,
    token: /^[0-9a-f]{32,128}$/i,
    ipv4: /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
    localUrl: /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/,
    ctrId: /^[0-9a-f]{12}$/,
  };
  function vmNameProblem(n) {
    if (!n) return 'Enter a name.';
    if (!RE.vm.test(n)) return 'Use 1-63 letters, digits, ".", "_" or "-", starting with a letter or digit.';
    if (/\.$/.test(n)) return 'The name cannot end with ".".';
    return null;
  }
  function imageProblem(img) {
    if (!img) return 'Enter an image reference, for example nginx:alpine.';
    if (!RE.image.test(img)) return '"' + img.slice(0, 80) + '" is not a valid image reference (letters, digits and . _ / : @ - only).';
    return null;
  }

  const ACCEL_NAMES = {
    auto: 'Automatic', whpx: 'WHPX (Windows Hypervisor Platform)', kvm: 'KVM', hvf: 'HVF (macOS Hypervisor)',
    tcg: 'TCG (software emulation)',
  };
  const accelName = (a) => ACCEL_NAMES[a] || String(a || '');
  const STATUS_TEXT = { stopped: 'stopped', booting: 'booting', running: 'running', stopping: 'stopping', missing: 'disk missing', error: 'error' };
  const isUp = (v) => !!v && (v.status === 'running' || v.status === 'booting');

  // ===========================================================================
  // links (only to this PC or the LAN addresses the manager reported)
  // ===========================================================================
  function lanAddrs() {
    const list = (STATE && STATE.platform && STATE.platform.lanAddresses) || [];
    return list.filter((ip) => {
      const m = RE.ipv4.exec(String(ip));
      return !!m && m.slice(1).every((x) => +x <= 255);
    });
  }
  function link(href, text) {
    return h('a', { href: href, target: '_blank', rel: 'noopener noreferrer' }, text || href);
  }
  // A hyperlink printed in a VM terminal: the full address in the app's own
  // dialog, as a real link the user may click (no confirm()/window.open()).
  function showGuestLink(uri) {
    let u;
    try { u = new URL(String(uri)); } catch (e) { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    const a = link(u.href);
    a.className = 'mono';
    a.addEventListener('click', () => { if (MODAL) MODAL.close(null); });
    openModal({
      title: 'Open a link from the VM?',
      hint: 'A program running in the VM printed this link. The text it showed may differ from where it really goes - open it only if you expected this address.',
      content: h('p', { class: 'breakall' }, a),
      submitLabel: null, cancelLabel: 'Close',
    });
  }
  // [{url, lan, host | hostPort}] from a deploy result or a container
  // summary -> <a> elements (only 127.0.0.1 / reported LAN addresses)
  function urlLinks(list) {
    const out = [];
    for (const u of Array.isArray(list) ? list : []) {
      if (!u || typeof u !== 'object') continue;
      let port = Number.isInteger(u.host) ? u.host : (Number.isInteger(u.hostPort) ? u.hostPort : null);
      if (port === null && typeof u.url === 'string') {
        const m = RE.localUrl.exec(u.url);
        if (m) port = parseInt(m[1], 10);
      }
      if (!isPort(port)) continue;
      out.push(link('http://127.0.0.1:' + port + '/'));
      if (u.lan) for (const ip of lanAddrs()) out.push(link('http://' + ip + ':' + port + '/'));
    }
    return out;
  }
  function exposureTag(lan) {
    return lan ? h('span', { class: 'tag lan', title: 'Other devices on your network can connect' }, 'LAN')
      : h('span', { class: 'tag local', title: 'Only programs on this PC can connect - including the VMs and containers running on it' }, 'this PC only');
  }
  // The published ports of a container: tcp ones as links, udp as text,
  // each with its exposure badge. Ports are integers from the manager.
  function ctrPortNodes(ports) {
    const out = [];
    for (const p of Array.isArray(ports) ? ports : []) {
      if (!p || !isPort(p.host)) continue;
      const udp = p.proto === 'udp';
      const label = '127.0.0.1:' + p.host + (isPort(p.guest) && p.guest !== p.host ? ' → ' + p.guest : '') + (udp ? '/udp' : '');
      out.push(h('div', { class: 'nowrap' }, udp ? h('span', { class: 'mono' }, label) : link('http://127.0.0.1:' + p.host + '/', label),
        ' ', exposureTag(!!p.lan)));
      if (p.lan && !udp) for (const ip of lanAddrs()) out.push(h('div', { class: 'small' }, link('http://' + ip + ':' + p.host + '/')));
    }
    return out;
  }
  // A manager route that exists but whose work has not landed answers 501.
  const notImpl = (e) => !!e && (e.status === 501 || e.code === 'NOT_IMPLEMENTED');

  // The user-facing caveat for live shared folders (SPEC-shares section 8):
  // the same words in the VM settings, the run form, the README and MCP.
  const SHARE_CAVEAT = 'Edits you make on Windows appear in the VM within a few tens of milliseconds, and files written in the VM are saved on '
    + 'Windows immediately. Changes made on Windows do not raise file-watch (inotify) events inside the VM, so dev servers that watch '
    + 'files need polling mode (e.g. CHOKIDAR_USEPOLLING=1, WATCHPACK_POLLING=true, vite server.watch.usePolling). Execute bits set '
    + 'with chmod +x are not stored (scripts and binaries are detected automatically); symlinks must stay inside the shared folder.';
  // What a share's access means inside the guest (lib/shares.js ACCESS_NOTE)
  const SHARE_ACCESS = 'Every program in the VM or container can use the WHOLE shared folder with the share\'s access (read-write unless the share is '
    + 'read-only) - also a Docker container inside a VM that only sees a sub-folder or mounts it ":ro": those do not limit it. Share only folders '
    + 'the guest may change, and make the share read-only when it should not.';

  // A folder on this PC (a live share) rather than a named volume: the same
  // test as the manager's parser (lib/microvm/args.js looksLikeHostPath).
  const isHostPath = (s) => /^[\\/.~]/.test(s) || /^[A-Za-z]:[\\/]/.test(s) || /^[A-Za-z]:$/.test(s);
  const RE_VOLUME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
  const RE_ENVNAME = /^[^=\s\0]{1,255}$/;

  // "sh -c 'echo hi'" -> ['sh', '-c', 'echo hi'] (single and double quotes,
  // backslash escapes outside single quotes); null when a quote is unclosed.
  function splitArgs(s) {
    const out = [];
    let cur = '', has = false, q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
      if (q === '"') {
        if (c === '"') q = null;
        else if (c === '\\' && i + 1 < s.length && /["\\$`]/.test(s[i + 1])) cur += s[++i];
        else cur += c;
        continue;
      }
      if (c === "'" || c === '"') { q = c; has = true; continue; }
      if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
      if (/\s/.test(c)) { if (has || cur) { out.push(cur); cur = ''; has = false; } continue; }
      cur += c;
    }
    if (q) return null;
    if (has || cur) out.push(cur);
    return out;
  }

  // ===========================================================================
  // clipboard
  // ===========================================================================
  async function copyText(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied ' + (what || 'to the clipboard'), 'ok');
      return;
    } catch (e) { /* blocked: fall back to a dialog */ }
    const box = h('textarea', { class: 'short', readonly: true, 'aria-label': what || 'Text to copy', spellcheck: 'false' });
    box.value = text;
    openModal({
      title: 'Copy ' + (what || 'this'),
      hint: 'The browser did not allow clipboard access. The text below is selected - press Ctrl+C (Cmd+C on a Mac).',
      content: box, submitLabel: 'Close', cancelLabel: null, initialFocus: box,
      onOpen: () => box.select(),
    });
  }

  // ===========================================================================
  // access token + API
  // ===========================================================================
  const TOKEN_KEY = 'devbox-vm-manager.token';
  let TOKEN = null;
  let AUTH_NEEDED = false;
  let OFFLINE = false;

  function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storageSet(k, v) {
    try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ }
  }
  function initToken() {
    let fromUrl = null;
    const hash = location.hash.replace(/^#/, '');
    if (hash) {
      let t = null;
      try { t = new URLSearchParams(hash).get('token'); } catch (e) { t = null; }
      if (t !== null) {
        // drop the fragment: keeps the token out of the address bar, bookmarks and history
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
        t = t.trim();
        if (RE.token.test(t)) fromUrl = t;
      }
    }
    if (fromUrl) { storageSet(TOKEN_KEY, fromUrl); return fromUrl; }
    const stored = storageGet(TOKEN_KEY);
    return stored && RE.token.test(stored) ? stored : null;
  }

  class ApiError extends Error {
    constructor(message, status, code, body) {
      super(message);
      this.status = status || 0;
      this.code = code || null;
      this.body = body || null;
    }
  }

  // Every call to the manager goes through here: token header, JSON in and
  // out, one error shape. Non-JSON replies (a proxy page, an old manager)
  // become a readable error instead of a crash.
  async function api(path, opts) {
    opts = opts || {};
    const headers = {};
    if (TOKEN) headers['X-DevBox-Token'] = TOKEN;
    const init = { method: 'GET', headers: headers, cache: 'no-store', credentials: 'same-origin' };
    if (opts.body !== undefined) {
      init.method = 'POST';
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    if (opts.keepalive) init.keepalive = true;
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      setOffline(true);
      const err = new ApiError('The manager is not reachable - is it still running?', 0, 'NETWORK');
      err.network = true;
      throw err;
    }
    let text = '';
    try { text = await res.text(); } catch (e) { text = ''; }
    let j = null;
    if (text) { try { j = JSON.parse(text); } catch (e) { j = null; } }
    setOffline(false);
    if (res.status === 401) {
      needAuth();
      const err = new ApiError('The access token is missing or wrong', 401, 'UNAUTHORIZED', j);
      err.auth = true;
      throw err;
    }
    if (!j || typeof j !== 'object') {
      throw new ApiError('Unexpected reply from the manager (HTTP ' + res.status + ')', res.status, 'BAD_REPLY');
    }
    if (!res.ok || j.ok === false) {
      throw new ApiError(j.error || ('The request failed (HTTP ' + res.status + ')'), res.status, j.code, j);
    }
    return j;
  }
  const post = (path, body, extra) => api(path, Object.assign({ body: body || {} }, extra || {}));

  function toastError(e) {
    if (!e || e.auth) return; // the token screen explains it
    toast(e.message || String(e), 'err');
  }

  function setOffline(on) {
    if (OFFLINE === on) return;
    OFFLINE = on;
    $('#bannerOffline').hidden = !on;
    if (on) setText($('#sub'), 'the manager is not reachable');
  }

  function needAuth() {
    if (AUTH_NEEDED) return;
    AUTH_NEEDED = true;
    closeModal();
    $('#main').hidden = true;
    $('#authScreen').hidden = false;
    setText($('#sub'), 'access token needed');
    setTimeout(() => $('#authToken').focus(), 50);
  }

  async function submitToken(e) {
    e.preventDefault();
    const err = $('#authErr');
    const t = $('#authToken').value.trim();
    if (!RE.token.test(t)) {
      showErr(err, 'That does not look like the token: it is one long line of the letters a-f and digits 0-9.', $('#authToken'));
      return;
    }
    TOKEN = t;
    AUTH_NEEDED = false;
    try {
      await api('/api/tasks');
    } catch (ex) {
      showErr(err, ex.auth ? 'The manager did not accept that token. Copy it again from the manager-token file, or use the link from the console window.' : ex.message, $('#authToken'));
      return;
    }
    storageSet(TOKEN_KEY, t);
    $('#authToken').value = '';
    hideErr(err);
    $('#authScreen').hidden = true;
    $('#main').hidden = false;
    pokePoll(0);
  }

  // ===========================================================================
  // toasts (an aria-live region, so screen readers hear them - UI-21)
  // ===========================================================================
  function toast(msg, kind, extra) {
    const box = $('#toasts');
    const t = h('div', { class: 'toast ' + (kind || ''), role: kind === 'err' ? 'alert' : null },
      h('div', { class: 'tmsg' }, msg, extra ? h('div', { class: 'urls' }, extra) : null),
      h('button', { type: 'button', class: 'tx', 'aria-label': 'Dismiss', onclick: () => t.remove() }, '×'));
    box.appendChild(t);
    while (box.children.length > 4) box.firstElementChild.remove();
    setTimeout(() => t.remove(), kind === 'err' ? 10000 : (extra ? 15000 : 5000));
  }

  // ===========================================================================
  // modal dialog (instead of the native browser dialogs - UI-12, UI-13)
  // ===========================================================================
  // openModal(o) -> Promise of the form data on submit, or null when cancelled.
  //   o: {title, hint (text), content (Node|Node[]), submitLabel (null = none),
  //       cancelLabel (null = none), danger, wide, initialFocus, onOpen(m),
  //       onSubmit(data, m) -> false to stay open | anything; a thrown error is
  //       shown inside the dialog and it stays open, keeping what was typed}
  // role=dialog + aria-modal, the page behind is inert, Tab stays inside,
  // Escape cancels, focus returns to where it was. Opening a dialog while one
  // is open resolves the older one with null (never a dangling promise).
  let MODAL = null;
  function focusables(root) {
    return $$('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', root)
      .filter((el) => el.getClientRects().length > 0);
  }
  function collectForm(box) {
    const d = {};
    for (const i of $$('input,select,textarea', box)) {
      if (!i.name) continue;
      if (i.type === 'checkbox') d[i.name] = i.checked;
      else if (i.type === 'radio') { if (i.checked) d[i.name] = i.value; }
      else d[i.name] = i.value;
    }
    return d;
  }
  function openModal(o) {
    if (MODAL) MODAL.close(null);
    return new Promise((resolve) => {
      const back = $('#modal'), box = $('#modalBox'), app = $('#app');
      const prevFocus = document.activeElement;
      const errEl = h('div', { class: 'field-error', role: 'alert', hidden: true });
      const submitBtn = o.submitLabel === null ? null
        : h('button', { type: 'submit', class: 'sm ' + (o.danger ? 'danger' : 'primary') }, o.submitLabel || 'OK');
      const cancelBtn = o.cancelLabel === null ? null : h('button', { type: 'button', class: 'sm' }, o.cancelLabel || 'Cancel');
      const form = h('form', { autocomplete: 'off', novalidate: true },
        h('div', { class: 'mbody' }, o.hint ? h('div', { class: 'mhint', id: 'modalHint' }, o.hint) : null, o.content || null, errEl),
        h('div', { class: 'mfoot' }, cancelBtn, submitBtn));
      box.className = 'modal' + (o.wide ? ' wide' : '');
      setChildren(box, h('div', { class: 'mhead' }, h('h3', { id: 'modalTitle' }, o.title || '')), form);
      if (o.hint) box.setAttribute('aria-describedby', 'modalHint'); else box.removeAttribute('aria-describedby');
      back.hidden = false;
      app.inert = true;
      app.setAttribute('aria-hidden', 'true');
      let busy = false;
      const m = {
        box: box,
        close(v) {
          if (MODAL !== m) return;
          MODAL = null;
          document.removeEventListener('keydown', onKey, true);
          back.hidden = true;
          box.textContent = '';
          app.inert = false;
          app.removeAttribute('aria-hidden');
          if (prevFocus && prevFocus !== document.body && document.contains(prevFocus)) {
            try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
          }
          resolve(v);
        },
        error(msg) { showErr(errEl, msg || null); },
      };
      MODAL = m;
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); if (!busy) m.close(null); return; }
        if (e.key !== 'Tab') return;
        const f = focusables(box);
        if (!f.length) { e.preventDefault(); return; }
        const first = f[0], last = f[f.length - 1], cur = document.activeElement;
        if (e.shiftKey && (cur === first || !box.contains(cur))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (cur === last || !box.contains(cur))) { e.preventDefault(); first.focus(); }
      }
      document.addEventListener('keydown', onKey, true);
      back.onmousedown = (e) => { if (e.target === back && !busy) m.close(null); };
      if (cancelBtn) cancelBtn.addEventListener('click', () => m.close(null));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy) return;
        const data = collectForm(box);
        if (!o.onSubmit) { m.close(data); return; }
        busy = true;
        if (submitBtn) submitBtn.disabled = true;
        m.error(null);
        let r;
        try { r = await o.onSubmit(data, m); } catch (ex) { r = false; if (!ex.auth) m.error(ex.message || String(ex)); }
        busy = false;
        if (submitBtn) submitBtn.disabled = false;
        if (r === false || MODAL !== m) return;
        m.close(r === undefined || r === true ? data : r);
      });
      // a destructive confirm starts on Cancel, so Enter never deletes by accident
      const target = o.initialFocus
        || (o.danger ? cancelBtn : null)
        || box.querySelector('input:not([readonly]):not([type=hidden]),select,textarea:not([readonly])')
        || submitBtn || cancelBtn;
      setTimeout(() => {
        if (MODAL !== m) return;
        if (target) target.focus();
        if (o.onOpen) o.onOpen(m);
      }, 30);
    });
  }
  function closeModal() { if (MODAL) MODAL.close(null); }
  async function confirmDialog(title, text, label) {
    return !!(await openModal({ title: title, hint: text, submitLabel: label || 'Delete', danger: true }));
  }
  function textDialog(title, text) {
    return openModal({ title: title, content: h('pre', { tabindex: '0' }, text), submitLabel: 'Close', cancelLabel: null, wide: true });
  }

  // ===========================================================================
  // tasks: start, follow, task center
  // ===========================================================================
  const TASKS = {
    byId: new Map(),        // id -> latest summary
    running: [],            // from the last /api/state
    recent: [],
    mine: new Map(),        // id -> {resolve, opts}: started by this page
    seenRunning: new Set(), // seen running while this page was open (toast when they end)
    finished: new Set(),    // completion already handled
    hidden: new Set(),      // finished tasks the user cleared
    expanded: new Set(),    // tasks whose log is open
    rows: new Map(),        // id -> task center row
    fetching: new Set(),
  };
  const SETUP_KINDS = /^(setup|install-qemu|build-base|install-kernel)$/;
  // quick synchronous calls that also appear in the task history (port
  // changes): their own reply already told the user, so no second toast
  const QUIET_KINDS = /^(ports|share-add|share-remove)$/;

  function noteTask(t) {
    if (!t || !t.id) return;
    const s = Object.assign({}, TASKS.byId.get(t.id), t);
    delete s.log;
    TASKS.byId.set(t.id, s);
  }

  // A spinner in the button while the request is sent. The label is never
  // replaced, so it cannot be left wrong or carry typed text (UI-18).
  function busyButton(b) {
    if (!b) return () => {};
    const was = b.disabled;
    b.disabled = true;
    b.setAttribute('aria-busy', 'true');
    const sp = h('span', { class: 'spin', 'aria-hidden': 'true' });
    b.insertBefore(sp, b.firstChild);
    return () => { sp.remove(); b.disabled = was; b.removeAttribute('aria-busy'); };
  }

  // POST a task route. Resolves {task, done} once the manager accepted it
  // (`done` resolves with the final task); rejects with the refusal (bad
  // input, busy, not reachable) - nothing was started then.
  async function startTask(path, body, opts) {
    const j = await post(path, body);
    const task = j.task;
    if (!task || !task.id) throw new ApiError('The manager did not return a task', 500, 'BAD_REPLY');
    return followTask(task, opts, j);
  }
  // Follow a task the manager accepted. reply: the whole 202 body (a run
  // also says which engine it chose, and why).
  function followTask(task, opts, reply) {
    noteTask(task);
    TASKS.seenRunning.add(task.id);
    const done = new Promise((resolve) => TASKS.mine.set(task.id, { resolve: resolve, opts: opts || {} }));
    if (task.status && task.status !== 'running') handleFinished(TASKS.byId.get(task.id));
    renderTasks();
    pokePoll(250);
    return { task: task, done: done, reply: reply || {} };
  }
  // POST a route that answers either synchronously or with a task (a forced
  // container remove, a share change that needs SSH): resolves the final
  // task, or the synchronous reply. Throws the refusal.
  async function postMaybeTask(path, body, opts) {
    const j = await post(path, body);
    if (j.task && j.task.id) {
      const t = await followTask(j.task, opts, j).done;
      if (t && t.status !== 'done') throw new ApiError(firstLine(t.error) || 'The task failed', 500, 'TASK_FAILED');
      return (t && t.result) || {};
    }
    return j;
  }

  // runTask(path, body, {btn, onAccepted(task, reply), onError(err), quiet})
  // -> the final task summary, or null when the request was refused (the
  // error is shown by onError, else as a toast).
  async function runTask(path, body, opts) {
    opts = opts || {};
    const undo = busyButton(opts.btn);
    let started;
    try {
      started = await startTask(path, body, opts);
    } catch (e) {
      undo();
      if (opts.onError && !e.auth) opts.onError(e); else toastError(e);
      return null;
    }
    undo();
    if (opts.onAccepted) { try { opts.onAccepted(started.task, started.reply); } catch (e) { console.error(e); } }
    return started.done;
  }

  function updateTasks(ov) {
    const running = (ov && ov.running) || [], recent = (ov && ov.recent) || [];
    TASKS.running = running;
    TASKS.recent = recent;
    for (const t of running) { noteTask(t); TASKS.seenRunning.add(t.id); }
    for (const t of recent) {
      noteTask(t);
      if (TASKS.seenRunning.has(t.id) || TASKS.mine.has(t.id)) handleFinished(TASKS.byId.get(t.id));
    }
    // followed tasks that neither list shows any more: ask for them by id
    const listed = new Set(running.concat(recent).map((t) => t.id));
    for (const id of TASKS.mine.keys()) if (!listed.has(id)) fetchTask(id);
    for (const id of TASKS.seenRunning) if (!listed.has(id) && !TASKS.finished.has(id)) fetchTask(id);
    renderTasks();
  }

  async function fetchTask(id) {
    if (TASKS.fetching.has(id)) return;
    TASKS.fetching.add(id);
    try {
      const j = await api('/api/task?id=' + encodeURIComponent(id));
      if (j.task) {
        noteTask(j.task);
        if (j.task.status !== 'running') handleFinished(TASKS.byId.get(id));
      }
    } catch (e) {
      if (e.status === 404) {
        const known = TASKS.byId.get(id) || {};
        handleFinished(Object.assign({}, known, {
          id: id, status: 'error', title: known.title || 'A task',
          error: 'The manager no longer knows this task (it may have been restarted).',
        }));
      }
    } finally {
      TASKS.fetching.delete(id);
    }
  }

  function handleFinished(t) {
    if (!t || TASKS.finished.has(t.id)) return;
    TASKS.finished.add(t.id);
    const mine = TASKS.mine.get(t.id);
    const watched = !!mine || (TASKS.seenRunning.has(t.id) && !QUIET_KINDS.test(t.kind || ''));
    if (watched && !(mine && mine.opts.quiet)) {
      if (t.status === 'done') toast((t.title || 'Task') + ' - done', 'ok', resultNodes(t));
      else toast((t.title || 'Task') + ' failed: ' + firstLine(t.error), 'err');
    }
    if (mine) { TASKS.mine.delete(t.id); mine.resolve(t); }
    afterTaskFinished(t);
  }

  // Refresh what a finished task may have changed.
  function afterTaskFinished(t) {
    if (t.vm && t.vm === CURRENT) {
      if (TAB === 'docker' && /^(docker-|compose|deploy)/.test(t.kind || '')) loadDocker(true);
      if (TAB === 'network') loadNetwork(true);
    }
    if (t.ctr && t.ctr === CTRD.id) ctrdFetch(true);
    if (/^(image-|ctr-run|ctr-start)/.test(t.kind || '')) { if ($('#imgDetails').open) loadImages(true); }
    if (/^ctr-/.test(t.kind || '') && $('#volDetails').open) loadVolumes(true);
    pokePoll(0);
  }

  // Deploy URLs, "Manage <vm>" and similar, from a task result.
  function resultNodes(t) {
    const res = t && t.result;
    if (!res || typeof res !== 'object') return null;
    const out = [];
    const links = urlLinks(res.urls);
    if (links.length) out.push(h('span', null, 'Open: '), links);
    if (typeof res.bytesBefore === 'number' && typeof res.bytesAfter === 'number') {
      out.push(h('span', null, 'Disk file: ' + fmtBytes(res.bytesBefore) + ' → ' + fmtBytes(res.bytesAfter)));
    }
    const vmName = typeof res.sandbox === 'string' ? res.sandbox
      : ((t.kind === 'create' || t.kind === 'quickdeploy') && typeof res.name === 'string' ? res.name : null);
    if (vmName && RE.vm.test(vmName)) out.push(btn('Manage ' + vmName, 'sm', { onClick: () => selectVm(vmName) }));
    // a container run or start that ended because the app exited says so,
    // with a way to its output
    const cid = ctrIdOfTask(t);
    if (cid) {
      if (Number.isInteger(res.exitCode)) out.push(h('span', null, 'exited with code ' + res.exitCode));
      out.push(btn('Logs', 'sm', { onClick: () => selectCtr(cid, 'logs') }));
      out.push(btn('Manage container', 'sm', { onClick: () => selectCtr(cid) }));
    }
    return out.length ? out : null;
  }
  // The container a task worked on (ctr-run / ctr-start / ctr-stop).
  function ctrIdOfTask(t) {
    if (!t || !/^ctr-/.test(t.kind || '')) return null;
    const res = t.result && typeof t.result === 'object' ? t.result : {};
    const id = t.ctr || res.id || (res.container && res.container.id) || null;
    return typeof id === 'string' && RE.ctrId.test(id) ? id : null;
  }

  function renderTasks() {
    const running = TASKS.running.slice();
    // tasks this page started that the last /api/state did not list yet
    for (const id of TASKS.mine.keys()) {
      const t = TASKS.byId.get(id);
      if (t && t.status === 'running' && !running.some((x) => x.id === id)) running.unshift(t);
    }
    const recent = TASKS.recent.filter((t) => !TASKS.hidden.has(t.id) && !running.some((x) => x.id === t.id));
    $('#taskCard').hidden = !running.length && !recent.length;
    setText($('#taskCount'), running.length ? running.length + ' running' : '');
    $('#btnClearTasks').hidden = !recent.length;
    syncTaskList($('#taskRunning'), running);
    syncTaskList($('#taskRecent'), recent);
    for (const [id, r] of TASKS.rows) {
      if (!r.el.isConnected) { TASKS.rows.delete(id); TASKS.expanded.delete(id); }
    }
  }
  function syncTaskList(box, list) {
    const rows = list.map(taskRow);
    const want = new Set(rows.map((r) => r.el));
    for (const el of Array.from(box.children)) if (!want.has(el)) el.remove();
    const cur = Array.from(box.children);
    if (cur.length !== rows.length || rows.some((r, i) => cur[i] !== r.el)) {
      keepFocus(() => { for (const r of rows) box.appendChild(r.el); });
    }
  }
  function taskRow(t) {
    let r = TASKS.rows.get(t.id);
    if (!r) {
      const id = t.id;
      r = { id: id, status: null, resultShown: false, logBusy: false, logFinal: false };
      r.icon = h('span', { class: 'ticon' });
      r.title = h('span', { class: 'ttitle' });
      r.meta = h('span', { class: 'tmeta' });
      r.btn = h('button', { type: 'button', class: 'sm', 'aria-expanded': 'false', onclick: () => toggleTaskLog(id) }, 'Show log');
      r.err = h('div', { class: 'task-err', hidden: true });
      r.result = h('div', { class: 'task-result', hidden: true });
      r.pre = h('pre', { class: 'log', hidden: true, tabindex: '0', 'aria-label': 'Task log' });
      r.el = h('div', { class: 'task' }, h('div', { class: 'task-head' }, r.icon, r.title, r.meta, r.btn), r.err, r.result, r.pre);
      TASKS.rows.set(id, r);
    }
    const running = t.status === 'running';
    if (r.status !== t.status) {
      r.status = t.status;
      r.icon.className = 'ticon' + (running ? '' : (t.status === 'done' ? ' ok' : ' err'));
      if (running) setChildren(r.icon, h('span', { class: 'spin', 'aria-hidden': 'true' }), h('span', { class: 'sr-only' }, 'running'));
      else setChildren(r.icon, h('span', { 'aria-hidden': 'true' }, t.status === 'done' ? '✓' : '✗'), h('span', { class: 'sr-only' }, t.status === 'done' ? 'done' : 'failed'));
    }
    setText(r.title, t.title || t.kind || 'Task');
    let meta;
    if (running) meta = [t.step, t.startedAt ? 'running for ' + fmtDur(secondsSince(t.startedAt)) : null];
    else meta = [(t.status === 'done' ? 'finished ' : 'failed ') + ago(t.endedAt),
      t.startedAt && t.endedAt ? 'took ' + fmtDur((t.endedAt - t.startedAt) / 1000) : null];
    setText(r.meta, meta.filter(Boolean).join(' · '));
    if (!running && t.status === 'error') {
      setText(r.err, String(t.error || 'unknown error').split('\n').slice(0, 8).join('\n'));
      r.err.hidden = false;
    } else r.err.hidden = true;
    if (!running && t.status === 'done' && !r.resultShown) {
      r.resultShown = true;
      const nodes = resultNodes(t);
      if (nodes) { setChildren(r.result, nodes); r.result.hidden = false; }
    }
    return r;
  }
  function toggleTaskLog(id) {
    const r = TASKS.rows.get(id);
    if (!r) return;
    const open = !TASKS.expanded.has(id);
    if (open) TASKS.expanded.add(id); else TASKS.expanded.delete(id);
    r.pre.hidden = !open;
    r.btn.setAttribute('aria-expanded', String(open));
    r.btn.textContent = open ? 'Hide log' : 'Show log';
    if (open) {
      if (!r.pre.textContent) r.pre.textContent = 'loading...';
      r.logFinal = false;
      loadTaskLog(id, true);
    }
  }
  async function loadTaskLog(id, force) {
    const r = TASKS.rows.get(id);
    if (!r || !TASKS.expanded.has(id) || r.logBusy || (r.logFinal && !force)) return;
    r.logBusy = true;
    try {
      const j = await api('/api/task?id=' + encodeURIComponent(id));
      const task = j.task;
      if (!task) return;
      const pre = r.pre;
      const text = (task.log || []).join('\n') || '(no output yet)';
      if (pre.textContent !== text && !selectionIn(pre)) {
        const atEnd = force || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        pre.textContent = text;
        if (atEnd) pre.scrollTop = pre.scrollHeight;
      }
      if (task.status !== 'running') r.logFinal = true;
    } catch (e) {
      if (e.status === 404) { r.pre.textContent = '(the manager no longer keeps this task)'; r.logFinal = true; }
    } finally {
      r.logBusy = false;
    }
  }
  // open logs of running tasks follow along
  setInterval(() => {
    if (document.hidden || AUTH_NEEDED) return;
    for (const id of TASKS.expanded) loadTaskLog(id, false);
  }, 1500);

  // ===========================================================================
  // the polling loop
  // ===========================================================================
  const POLL_MS = 2500;
  let STATE = null;
  let VMS = new Map();
  let CTRS = new Map(); // container id -> summary from /api/state
  let pollBusy = false, pollQueued = false, pollTimer = null, firstState = true;
  // A poll that was already on its way when the user saved settings or port
  // forwards carries the OLD values; it must not refill those forms, or they
  // would flip back for one cycle. RENDER_ASKED_AT: when the state being
  // rendered was requested; LOCAL_WRITE_AT: when a save last succeeded.
  let RENDER_ASKED_AT = 0, LOCAL_WRITE_AT = 0;

  function schedulePoll(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, ms);
  }
  // Ask for a fresh state soon (after an action). Never runs two at once.
  function pokePoll(ms) {
    if (pollBusy) { pollQueued = true; return; }
    schedulePoll(ms || 0);
  }
  async function poll() {
    pollTimer = null;
    if (pollBusy) { pollQueued = true; return; }
    if (AUTH_NEEDED) return;                       // resumes once a token is entered
    if (document.hidden) { schedulePoll(POLL_MS); return; } // no work for a hidden tab
    pollBusy = true;
    let delay = POLL_MS;
    try {
      const askedAt = Date.now();
      const s = await api('/api/state');
      RENDER_ASKED_AT = askedAt;
      render(s);
    } catch (e) {
      if (e.network) delay = 3000;
      else if (!e.auth) setText($('#sub'), 'could not read the state: ' + e.message);
    } finally {
      pollBusy = false;
      if (!AUTH_NEEDED) {
        if (pollQueued) { pollQueued = false; delay = 0; }
        schedulePoll(delay);
      }
    }
  }
  document.addEventListener('visibilitychange', () => {
    // a hidden tab does not keep a container log tailing on the manager
    if (document.hidden) { if (CLOG.es || CLOG.timer) { clogStop(); CLOG.resume = true; } return; }
    pokePoll(0);
    if (TAB === 'serial') refreshLog(false);
    if (CLOG.resume) { CLOG.resume = false; if (CTRD.id && CTRD.tab === 'logs') clogLoad(); }
  });

  function render(s) {
    STATE = s;
    VMS = new Map((s.vms || []).map((v) => [v.name, v]));
    CTRS = new Map((Array.isArray(s.containers) ? s.containers : []).filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]));
    const steps = [renderHeader, renderSetup, renderHost, (x) => updateTasks(x.tasks), renderTemplates,
      renderVms, applyDefaults, renderDetail, renderContainers, renderCtrDetail, renderRunEngine, renderRunCard];
    for (const fn of steps) {
      try { fn(s); } catch (e) { console.error('render step failed', e); }
    }
    if (firstState) { firstState = false; openDeepLink(); }
  }

  function renderHeader(s) {
    const vms = s.vms || [];
    const on = vms.filter((v) => isUp(v) || v.status === 'stopping').length;
    const hs = s.host || {};
    const cs = Array.from(CTRS.values());
    const cOn = cs.filter(ctrLive).length;
    setText($('#sub'), [hs.hostname, hs.cpus ? hs.cpus + ' CPUs' : null,
      on + ' of ' + vms.length + ' VM' + (vms.length === 1 ? '' : 's') + ' running',
      cs.length ? cOn + ' of ' + cs.length + ' container' + (cs.length === 1 ? '' : 's') + ' running' : null,
      s.version ? 'v' + s.version : null].filter(Boolean).join(' · '));
    const w = $('#bannerState');
    w.hidden = !s.stateWarning;
    setText(w, s.stateWarning ? 'Warning: ' + s.stateWarning : '');
  }

  // ===========================================================================
  // setup / prerequisites (first run: one obvious button)
  // ===========================================================================
  const PREREQ_ORDER = ['qemu', 'microvm', 'microvmMachine', 'ssh', 'sevenzip', 'scp', 'sshkey', 'alpine', 'base'];
  const PREREQ_ACTIONS = {
    'install-qemu': { path: '/api/install/qemu', label: 'Install QEMU' },
    'build-base': { path: '/api/install/base', label: 'Download & build' },
    'install-kernel': { path: '/api/install/kernel', label: 'Install (about 43 MB)' },
    'probe-host': { path: '/api/host/probe', label: 'Probe this PC (1-3 min)', body: {} },
  };
  let prereqKey = '', prereqOpened = false;
  // what the two CTA buttons do right now: {path, body}
  const CTA = { primary: null, secondary: null };

  // Two kinds of "ready": Docker images need only QEMU and the microVM kernel
  // (about a minute); full VMs also need the base image (several minutes).
  // The CTA offers the quick path first (microVM spec 5.3 / 12.1).
  function renderSetup(s) {
    const p = s.prereqs || {};
    const keys = PREREQ_ORDER.filter((k) => p[k]).concat(Object.keys(p).filter((k) => PREREQ_ORDER.indexOf(k) === -1));
    const missing = keys.filter((k) => p[k] && p[k].required && !p[k].ok);
    const busy = ((s.tasks && s.tasks.running) || []).some((t) => SETUP_KINDS.test(t.kind || ''));
    const hasKernelRow = !!p.microvm;
    // /api/state microvm.ready = QEMU found and the kernel verifies
    const imagesReady = hasKernelRow && (s.microvm && typeof s.microvm.ready === 'boolean' ? s.microvm.ready : !!(p.microvm.ok && p.qemu && p.qemu.ok));
    let head, text, primary = null, secondary = null;
    if (hasKernelRow && !imagesReady) {
      head = 'Docker images need one quick setup step.';
      text = 'Running Docker images needs QEMU and the small microVM kernel (about 43 MB, verified) - about a minute. '
        + (missing.length ? 'Full VMs also need: ' + missing.map((k) => p[k].label || k).join(', ') + ' (a few minutes the first time).' : '');
      primary = { label: 'Set up for Docker images (about 1 minute)', path: '/api/setup', body: { only: 'microvm' } };
      secondary = { label: 'Set up everything', path: '/api/setup', body: {} };
    } else if (missing.length) {
      head = hasKernelRow ? 'Docker images: ready. Full VMs: not set up.' : 'A few things are missing before you can create VMs.';
      const onlyBase = missing.every((k) => k === 'base');
      text = 'Missing for full VMs: ' + missing.map((k) => p[k].label || k).join(', ') + '. One click downloads and prepares it; the first time takes a few minutes.';
      primary = hasKernelRow && onlyBase ? { label: 'Build the base image', path: '/api/install/base', body: {} }
        : { label: hasKernelRow ? 'Set up full VMs' : 'Set up everything', path: '/api/setup', body: {} };
    }
    CTA.primary = primary;
    CTA.secondary = secondary;
    $('#setupCta').hidden = !primary;
    if (primary) {
      setText($('#setupCtaHead'), head);
      setText($('#btnSetup'), primary.label);
      $('#btnSetup2').hidden = !secondary;
      if (secondary) setText($('#btnSetup2'), secondary.label);
      for (const b of [$('#btnSetup'), $('#btnSetup2')]) if (b.getAttribute('aria-busy') !== 'true') b.disabled = busy;
      setText($('#setupCtaText'), busy ? 'Setting up now - follow the progress under Tasks.' : text);
    }
    setText($('#prereqSummary'), missing.length ? 'Prerequisites: ' + missing.length + ' missing'
      : (hasKernelRow && !p.microvm.ok ? 'Prerequisites: VMs ready - the microVM kernel for Docker images is not installed' : 'Prerequisites: everything needed is installed'));
    if ((missing.length || (hasKernelRow && !imagesReady)) && !prereqOpened) { prereqOpened = true; $('#prereqDetails').open = true; }
    const key = JSON.stringify([p, busy]);
    if (key === prereqKey) return;
    prereqKey = key;
    const box = $('#prereqs');
    keepFocusIn(box, () => setChildren(box, keys.map((k) => prereqItem(k, p[k], busy))));
  }
  function ctaClick(b, which) {
    const a = CTA[which];
    if (a) runTask(a.path, a.body, { btn: b });
  }
  function prereqItem(k, it, busy) {
    const ok = !!it.ok;
    const cls = ok ? 'y' : (it.required ? 'n' : 'o');
    let act = !ok && it.action ? PREREQ_ACTIONS[it.action] : null;
    // QEMU installed and the manager can install it (Windows): offer an
    // update - it downloads the newest build and swaps it in (XTR-18)
    if (ok && it.action === 'install-qemu') act = { path: '/api/install/qemu', label: 'Update QEMU', secondary: true, confirm: true };
    // this QEMU has no "microvm" machine: the fix is a newer QEMU
    if (k === 'microvmMachine' && it.action === 'install-qemu') act = { path: '/api/install/qemu', label: 'Update QEMU', secondary: true, confirm: true };
    // an installed kernel that lacks a feature (e.g. shared folders) is
    // re-prepared from the verified packages already on disk - no download
    if (ok && it.action === 'install-kernel' && it.needsUpdate) act = { path: '/api/install/kernel', label: 'Update (no download)', secondary: true, body: {} };
    // the host probe can always be run again (a BIOS or driver change, a new Windows build)
    if (ok && it.action === 'probe-host') act = { path: '/api/host/probe', label: 'Probe again', secondary: true, body: {} };
    return h('div', { class: 'prereq' },
      h('div', { class: 'tick ' + cls, 'aria-hidden': 'true' }, ok ? '✓' : (it.required ? '✗' : '•')),
      h('div', { class: 'txt' },
        h('div', null, it.label || k, h('span', { class: 'sr-only' }, ok ? ' - ready' : (it.required ? ' - missing, required' : ' - not yet, optional')),
          !ok && !it.required ? h('span', { class: 'tag' }, 'optional') : null),
        h('div', { class: 'detail' }, it.detail || ''),
        !ok && it.fix ? h('div', { class: 'fix' }, h('span', null, it.fix),
          btn('Copy', 'sm', { fk: 'fix:' + k, aria: 'Copy the instructions for ' + (it.label || k), onClick: () => copyText(it.fix, 'the instructions') })) : null),
      act ? btn(act.label, act.secondary ? 'sm' : 'sm primary', { disabled: busy, fk: 'act:' + k, onClick: (b) => prereqAction(b, act) }) : null);
  }
  async function prereqAction(b, act) {
    if (act.confirm && !await confirmDialog('Update QEMU?',
      'The newest QEMU for Windows is downloaded (about 200 MB), checked and unpacked into the data folder, then used for VMs started from now on. '
      + 'All VMs and containers must be stopped first.', 'Update QEMU')) return;
    runTask(act.path, act.body || {}, { btn: b });
  }

  // ===========================================================================
  // host
  // ===========================================================================
  function setBar(bar, p, cls) {
    bar.className = 'bar' + (cls ? ' ' + cls : '');
    bar.firstElementChild.style.width = p + '%'; // CSSOM property, allowed by the CSP
  }
  function renderHost(s) {
    const hs = s.host || {};
    const mu = pct(hs.memUsed, hs.memTotal);
    setText($('#memTxt'), hs.memTotal ? fmtBytes(hs.memUsed) + ' used of ' + fmtBytes(hs.memTotal) + ' (' + (100 - mu) + '% free)' : '-');
    setBar($('#memBar'), mu, mu > 90 ? 'err' : (mu > 75 ? 'warn' : ''));
    setText($('#diskLabel'), 'Disk' + (hs.diskPath ? ' (' + hs.diskPath + ')' : ''));
    if (hs.diskTotal) {
      const du = pct(hs.diskUsed, hs.diskTotal);
      setText($('#diskTxt'), fmtBytes(hs.diskFree) + ' free of ' + fmtBytes(hs.diskTotal));
      setBar($('#diskBar'), du, du > 92 ? 'err' : (du > 80 ? 'warn' : ''));
    } else {
      setText($('#diskTxt'), hs.diskError ? 'unavailable' : '-');
      setBar($('#diskBar'), 0, '');
    }
    setText($('#accelTxt'), accelSummary(s));
    // the smaller defaults are active (brief 4: status shows the light profile)
    $('#lightTag').hidden = !(s.settings && s.settings.lightProfile);
    $('#accelHow').hidden = !(s.accelHint && typeof s.accelHint === 'object');
    // containers are QEMU processes too: their guest memory is committed in
    // full on Windows, so say how much of "used" they account for
    const live = Array.from(CTRS.values()).filter(ctrLive);
    const mem = live.reduce((a, c) => a + (Number.isFinite(c.mem) ? c.mem : 0), 0);
    // the accel each container really got (QEMU may fall back to TCG)
    const tcg = live.filter((c) => c.accel === 'tcg').length;
    let ct = live.length ? live.length + ' container' + (live.length === 1 ? '' : 's') + ' running' + (mem ? ', ' + mem + ' MB of guest memory (included in "used" above)' : '') + '.' : '';
    if (tcg) ct += ' ' + tcg + ' of them run' + (tcg === 1 ? 's' : '') + ' under TCG software emulation: slower, and not a security boundary.';
    $('#hostCtrTxt').hidden = !ct;
    setText($('#hostCtrTxt'), ct);
  }
  function accelSummary(s) {
    const a = (s.platform && s.platform.accel) || {};
    const forced = s.settings && s.settings.accel && s.settings.accel !== 'auto' ? s.settings.accel : null;
    const ah = s.accelHint && typeof s.accelHint === 'object' ? s.accelHint : null;
    let t;
    if (a.detecting) t = 'Acceleration: checking what this PC supports...';
    else if (!a.available) t = 'Acceleration: known once QEMU is installed.';
    else if (a.recommended && a.recommended !== 'tcg') t = 'Acceleration: ' + accelName(a.recommended) + ' is available - VMs run at near-native speed.';
    else {
      t = 'Acceleration: no hardware accelerator found - VMs and containers use TCG software emulation (works everywhere, but slower and heavier).';
      if (ah && ah.insideVm) t += ' This PC is itself a virtual machine' + (ah.outerLabel ? ' (' + ah.outerLabel + ')' : '') + ': its nested virtualization is off.';
    }
    if (forced) t += ' The global setting forces ' + accelName(forced) + '.';
    return t;
  }
  // ---- no hardware acceleration: how to turn it on (SPEC-diskroot 11) ----
  // The manager's hint (install.accelHint) as nodes. All of it is text from
  // the manager; `backticks` mark commands, shown as <code> - never markup.
  function codeText(s) {
    return String(s || '').split('`').map((p, i) => (i % 2 ? h('code', null, p) : p));
  }
  function accelHintNodes(ah) {
    const out = [h('p', { class: 'ahint-sum' }, ah.summary || '')];
    for (const k of Object.keys(ah.steps && typeof ah.steps === 'object' ? ah.steps : {})) {
      const list = Array.isArray(ah.steps[k]) ? ah.steps[k] : [];
      if (!list.length) continue;
      out.push(h('div', { class: 'ahead' }, (ah.labels && ah.labels[k]) || k), h('ol', { class: 'asteps' }, list.map((x) => h('li', null, codeText(x)))));
    }
    const inner = Array.isArray(ah.inner) ? ah.inner : [];
    if (inner.length) out.push(h('div', { class: 'ahead' }, 'On this PC'), h('ol', { class: 'asteps' }, inner.map((x) => h('li', null, codeText(x)))));
    if (ah.readme) out.push(h('div', { class: 'small' }, 'The same steps are in ' + ah.readme + ' (in the manager\'s folder).'));
    return h('div', { class: 'ahint' }, out);
  }
  function showAccelHint() {
    const ah = STATE && STATE.accelHint;
    if (!ah) return;
    openModal({ title: 'Turn on hardware acceleration', wide: true, content: accelHintNodes(ah), submitLabel: null, cancelLabel: 'Close' });
  }

  // ===========================================================================
  // limits and defaults for number inputs (OPS-16) - never over typed values
  // ===========================================================================
  function limits() {
    const L = (STATE && STATE.limits) || {};
    return {
      minMem: L.minMem || 256, maxMem: L.maxMem || 8192, defaultMem: L.defaultMem || 1024,
      maxCpus: L.maxCpus || 4, defaultCpus: L.defaultCpus || 2,
      minDiskGB: L.minDiskGB || 2, maxDiskGB: L.maxDiskGB || 512,
    };
  }
  const defaultLan = () => !!(STATE && STATE.settings && STATE.settings.defaultExpose === 'lan');
  function setDefault(el, v) { if (!el.dataset.touched) el.value = String(v); }
  function setDefaultCheck(el, v) { if (!el.dataset.touched) el.checked = !!v; }
  let limitsKey = '';
  function applyDefaults() {
    const L = limits();
    const key = JSON.stringify(L);
    if (key !== limitsKey) {
      limitsKey = key;
      for (const id of ['#nwMem', '#sMem']) { const el = $(id); el.min = L.minMem; el.max = L.maxMem; }
      // a microVM needs far less than a VM; blank = the engine's default
      for (const id of ['#qMem', '#csMem']) $(id).max = L.maxMem;
      for (const id of ['#nwCpu', '#qCpu', '#sCpu', '#csCpu']) { const el = $(id); el.min = 1; el.max = L.maxCpus; }
      $('#dkSize').min = L.minDiskGB;
      $('#dkSize').max = L.maxDiskGB;
    }
    setDefault($('#nwMem'), L.defaultMem);
    setDefault($('#nwCpu'), L.defaultCpus);
    setDefaultCheck($('#qLan'), defaultLan());
    setDefaultCheck($('#dpLan'), defaultLan());
    // the run form starts on the global default root filesystem
    const before = $('#qRootfs').value;
    setDefault($('#qRootfs'), mvDefaults().rootfs);
    if ($('#qRootfs').value !== before) onRootfsChange();
    syncMemMin();
    // the disk-root default follows the settings (light profile: 112 MB)
    if ($('#qRootfs').value !== 'ram') $('#qMem').placeholder = 'automatic: ' + mvDefaults().memMB + ' MB';
    $('#csMem').placeholder = $('#csRootfs').value === 'ram' ? 'automatic (sized to the image)' : 'automatic: ' + mvDefaults().memMB + ' MB';
  }
  // Container defaults: the engine's (/api/state microvm.defaults), else the
  // global settings, else the built-in ones. A disk-root container boots at
  // 96 MB (the engine's lower bound, lib/microvm/validate.js); a RAM root
  // needs at least 128 because the whole image sits in its memory.
  function mvDefaults() {
    const d = (STATE && STATE.microvm && STATE.microvm.defaults) || {};
    const s = (STATE && STATE.settings) || {};
    return {
      rootfs: d.rootfs === 'ram' || d.rootfs === 'disk' ? d.rootfs : (s.microvmRootfs === 'ram' ? 'ram' : 'disk'),
      memMB: Number.isInteger(d.memMB) ? d.memMB : (Number.isInteger(s.microvmMemMB) ? s.microvmMemMB : 128),
      minMemMB: Number.isInteger(d.minMemMB) ? d.minMemMB : 96,
      ramMinMemMB: Number.isInteger(d.ramMinMemMB) ? d.ramMinMemMB : 128,
    };
  }
  const minMemFor = (rootfs) => (rootfs === 'ram' ? mvDefaults().ramMinMemMB : mvDefaults().minMemMB);
  function syncMemMin() {
    $('#qMem').min = minMemFor($('#qRootfs').value);
    $('#csMem').min = minMemFor($('#csRootfs').value);
  }
  // what the Root filesystem choice means, under the select (spec 9)
  const ROOTFS_WHY = {
    disk: 'Disk: the image is written once to a read-only disk that every container of it shares; this container gets its own small '
      + 'writable layer on top. It needs about 128 MB of RAM whatever the image size and starts as fast or faster. Files it changes outside '
      + 'volumes are kept across restarts until you remove it (or start it fresh).',
    ram: 'RAM: the whole image is unpacked into the container\'s memory at every start (about 2 x the image + 90 MB of RAM, so big images '
      + 'are refused or sent to Docker-in-VM) and every start begins from the clean image. Only for special cases; Disk is lighter.',
  };
  // the memory field's hint per root filesystem (SPEC-diskroot 16, cov-4): a
  // disk root that is too small slows to a crawl rather than failing
  function memWhy(rootfs) {
    if (rootfs === 'ram') return 'Memory: blank = sized to the image, which is held in RAM (at least ' + mvDefaults().ramMinMemMB + ' MB).';
    return 'Memory: blank = ' + mvDefaults().memMB + ' MB, or more for apps known to need it (PostgreSQL 256 MB; MySQL, MariaDB, MongoDB and Java apps 512 MB; Elasticsearch 1 GB). '
      + 'Below 128 MB only for small apps: a container that is too small slows to a crawl instead of failing. Databases and Java apps want 512 MB or more.';
  }
  function checkMemCpu(mem, cpus) {
    const L = limits();
    if (mem !== undefined && (mem === null || mem < L.minMem || mem > L.maxMem)) return 'Memory must be a number from ' + L.minMem + ' to ' + L.maxMem + ' MB.';
    if (cpus !== undefined && (cpus === null || cpus < 1 || cpus > L.maxCpus)) return 'vCPUs must be a number from 1 to ' + L.maxCpus + '.';
    return null;
  }

  // ===========================================================================
  // templates + "Create a VM"
  // ===========================================================================
  let tplKey = '';
  function renderTemplates(s) {
    const bases = s.bases || [];
    const key = JSON.stringify(bases.map((b) => [b.name, b.size, b.usedBy, b.isDefault]));
    if (key !== tplKey) {
      tplKey = key;
      const box = $('#templates');
      if (!bases.length) {
        setChildren(box, h('div', { class: 'empty' }, 'No templates yet - "Set up everything" above builds the base image.'));
      } else {
        keepFocusIn(box, () => setChildren(box, h('div', { class: 'tablewrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Template'), h('th', { scope: 'col' }, 'Size'),
            h('th', { scope: 'col' }, 'Used by'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
          h('tbody', null, bases.map((b) => h('tr', null,
            h('td', null, h('b', null, b.name), b.isDefault ? h('span', { class: 'tag' }, 'default') : null),
            h('td', { class: 'mono' }, fmtBytes(b.size)),
            h('td', { class: 'mono' }, (b.usedBy || 0) + ' VM' + (b.usedBy === 1 ? '' : 's')),
            h('td', null, btn('New VM from this', 'sm primary', { fk: 'tpl:' + b.name, aria: 'New VM from ' + b.name, onClick: () => newVmDialog(b.name) })))))))));
      }
    }
    syncTemplateSelect($('#nwTpl'), bases);
  }
  // Rebuilt only when the template names change, keeping the user's choice (UI-2).
  function syncTemplateSelect(sel, bases) {
    const key = bases.map((b) => b.name).join('\n');
    if (sel.dataset.key === key) return;
    const cur = sel.value;
    sel.dataset.key = key;
    if (!bases.length) { setChildren(sel, h('option', { value: '' }, '(no templates yet)')); return; }
    setChildren(sel, bases.map((b) => h('option', { value: b.name }, b.name + (b.isDefault ? ' (default)' : ''))));
    if (bases.some((b) => b.name === cur)) sel.value = cur;
    else { const d = bases.find((b) => b.isDefault) || bases[0]; sel.value = d.name; }
  }

  function newVmDialog(template) {
    const L = limits();
    const name = h('input', { id: 'fName', name: 'name', autocomplete: 'off', spellcheck: 'false', placeholder: 'lab3' });
    const mem = h('input', { id: 'fMem', name: 'mem', type: 'number', min: L.minMem, max: L.maxMem, step: 128, value: L.defaultMem });
    const cpus = h('input', { id: 'fCpus', name: 'cpus', type: 'number', min: 1, max: L.maxCpus, step: 1, value: L.defaultCpus });
    const start = h('input', { type: 'checkbox', name: 'start', checked: true });
    return openModal({
      title: 'New VM from "' + template + '"',
      hint: 'An instant copy-on-write clone of this template: usually well under a second and a few hundred KB, because the template is shared.',
      content: [field('fName', 'Name', name), field('fMem', 'Memory (MB)', mem), field('fCpus', 'vCPUs', cpus),
        h('label', { class: 'chk' }, start, ' Start it right away')],
      submitLabel: 'Create',
      onSubmit: async (d, m) => {
        const n = String(d.name || '').trim();
        const why = vmNameProblem(n) || checkMemCpu(toInt(d.mem), toInt(d.cpus));
        if (why) { m.error(why); return false; }
        // refusals (name taken, ...) are shown in the dialog, which stays open (UI-22)
        await startTask('/api/vm/create', { name: n, template: template, mem: toInt(d.mem), cpus: toInt(d.cpus), start: !!d.start, createdBy: 'gui' });
        return true;
      },
    });
  }

  async function createVm(b) {
    const err = $('#nwErr');
    const name = $('#nwName').value.trim();
    const mem = toInt($('#nwMem').value), cpus = toInt($('#nwCpu').value);
    const why = vmNameProblem(name);
    if (why) return showErr(err, why, $('#nwName'));
    const bad = checkMemCpu(mem, cpus);
    if (bad) return showErr(err, bad);
    if (!$('#nwTpl').value) return showErr(err, 'There is no template yet - run "Set up everything" first.');
    hideErr(err);
    await runTask('/api/vm/create', {
      name: name, template: $('#nwTpl').value, mem: mem, cpus: cpus,
      start: $('#nwStart').checked, ephemeral: $('#nwTemp').checked, createdBy: 'gui',
    }, {
      btn: b,
      onError: (e) => showErr(err, e.message), // what was typed stays (UI-22)
      onAccepted: () => { $('#nwName').value = ''; },
    });
  }

  // the appliance card: any OS image with a screen (lib/appliance.js)
  async function createAppliance(b) {
    const err = $('#apErr');
    const name = $('#apName').value.trim();
    const source = $('#apSource').value.trim();
    const mem = toInt($('#apMem').value), cpus = toInt($('#apCpu').value), diskGB = toInt($('#apDisk').value);
    const sha = $('#apSha').value.trim().toLowerCase();
    const why = vmNameProblem(name);
    if (why) return showErr(err, why, $('#apName'));
    if (!source) return showErr(err, 'Give the image: a file on this PC or an https:// link.', $('#apSource'));
    if (/^http:\/\//i.test(source)) return showErr(err, 'Only https:// links are downloaded.', $('#apSource'));
    const bad = checkMemCpu(mem, cpus);
    if (bad) return showErr(err, bad);
    if (!(diskGB >= 2)) return showErr(err, 'The disk must be at least 2 GB.', $('#apDisk'));
    if (sha && !/^[0-9a-f]{64}$/.test(sha)) return showErr(err, 'The sha256 is 64 hex characters.', $('#apSha'));
    hideErr(err);
    await runTask('/api/vm/create-appliance', {
      name: name, source: source, sha256: sha || undefined, firmware: $('#apFw').value, bus: $('#apBus').value, vga: $('#apVga').value, display: $('#apDisplay').value,
      diskGB: diskGB, mem: mem, cpus: cpus, sound: $('#apSound').checked, install: $('#apInstall').checked,
      start: $('#apStart').checked, ephemeral: $('#apTemp').checked, createdBy: 'gui',
    }, {
      btn: b,
      onError: (e) => showErr(err, e.message),
      onAccepted: () => { $('#apName').value = ''; },
    });
  }

  // ===========================================================================
  // VM list (rows are kept and updated in place)
  // ===========================================================================
  const VMROWS = new Map();
  let vmBody = null;
  function renderVms(s) {
    const vms = s.vms || [];
    const box = $('#vmTable');
    $('#btnCleanTemp').hidden = !vms.some((v) => v.ephemeral);
    if (!vms.length) {
      if (box.dataset.mode !== 'empty') {
        box.dataset.mode = 'empty';
        VMROWS.clear();
        setChildren(box, h('div', { class: 'empty' }, (s.bases || []).length ? 'No VMs yet - create one below, or deploy an app from a Docker image.'
          : 'No VMs yet. Once setup has finished you can create them below.'));
      }
      return;
    }
    if (box.dataset.mode !== 'table') {
      box.dataset.mode = 'table';
      VMROWS.clear();
      vmBody = h('tbody');
      setChildren(box, h('div', { class: 'tablewrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Name', 'Status', 'SSH port', 'Resources', 'Disk', 'Uptime'].map((x) => h('th', { scope: 'col' }, x)),
          h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
        vmBody)));
    }
    const rows = vms.map((v) => {
      let r = VMROWS.get(v.name);
      if (!r) { r = makeVmRow(v.name); VMROWS.set(v.name, r); }
      updateVmRow(r, v);
      return r;
    });
    for (const [n, r] of VMROWS) if (!VMS.has(n)) { r.tr.remove(); VMROWS.delete(n); }
    const cur = Array.from(vmBody.children);
    if (cur.length !== rows.length || rows.some((r, i) => cur[i] !== r.tr)) {
      keepFocus(() => { for (const r of rows) vmBody.appendChild(r.tr); });
    }
  }
  function makeVmRow(name) {
    const r = { name: name };
    r.tags = h('span');
    r.pill = h('span', { class: 'pill' });
    r.ssh = h('td', { class: 'mono' });
    r.res = h('td', { class: 'mono' });
    r.disk = h('td', { class: 'mono' });
    r.up = h('td', { class: 'mono' });
    r.act = h('div', { class: 'btns' });
    r.tr = h('tr', null, h('td', null, h('b', null, name), r.tags), h('td', null, r.pill), r.ssh, r.res, r.disk, r.up, h('td', null, r.act));
    return r;
  }
  function vmTags(v) {
    const out = [];
    if (isAppliance(v)) out.push(h('span', { class: 'tag appl', title: 'An appliance: its own OS image with a screen (SSH when the guest runs its own server)' }, 'appliance'));
    if (v.ephemeral) out.push(h('span', { class: 'tag temp', title: 'Removed by "Delete all temporary VMs"' }, 'temporary'));
    if (/^(mcp|claude)/.test(v.createdBy || '')) out.push(h('span', { class: 'tag claude', title: 'Created by Claude through the MCP server' }, 'Claude'));
    if (v.autostart) out.push(h('span', { class: 'tag', title: 'Starts with the manager' }, 'autostart'));
    if (v.pendingRestart) out.push(h('span', { class: 'tag warn', title: 'Changed settings apply on the next start' }, 'restart pending'));
    return out;
  }
  function statusPill(v) {
    return h('span', { class: 'pill s-' + v.status },
      h('span', { class: 'dot', 'aria-hidden': 'true' }), STATUS_TEXT[v.status] || v.status,
      v.busy ? h('span', { class: 'spin', title: 'working...' }) : null,
      v.busy ? h('span', { class: 'sr-only' }, ' (working)') : null);
  }
  function updateVmRow(r, v) {
    const sel = CURRENT === v.name;
    r.tr.classList.toggle('sel', sel);
    if (sel) r.tr.setAttribute('aria-current', 'true'); else r.tr.removeAttribute('aria-current');
    const tagKey = [v.kind, v.ephemeral, v.createdBy, v.autostart, v.pendingRestart].join('|');
    if (r.tagKey !== tagKey) { r.tagKey = tagKey; setChildren(r.tags, vmTags(v)); }
    const pillKey = v.status + '|' + !!v.busy;
    if (r.pillKey !== pillKey) {
      r.pillKey = pillKey;
      const pill = statusPill(v);
      r.pill.replaceWith(pill);
      r.pill = pill;
    }
    const sshKey = v.kind + '|' + v.port + '|' + v.sshLan;
    if (r.sshKey !== sshKey) {
      r.sshKey = sshKey;
      setChildren(r.ssh, isAppliance(v) ? h('span', { title: 'The guest\'s own SSH server, when it runs one' }, String(v.port)) : String(v.port), v.sshLan ? exposureTag(true) : null);
    }
    setText(r.res, v.mem + ' MB · ' + v.cpus + ' vCPU');
    setText(r.disk, fmtBytes(v.diskBytes));
    setText(r.up, isUp(v) && v.startedAt ? fmtDur(secondsSince(v.startedAt)) : '-');
    const actKey = v.status + '|' + !!v.busy;
    if (r.actKey !== actKey) { r.actKey = actKey; keepFocusIn(r.act, () => setChildren(r.act, vmActions(v))); }
  }
  function vmActions(v) {
    const n = v.name, busy = !!v.busy, out = [];
    if (v.status === 'stopped' || v.status === 'error') {
      out.push(btn('Start', 'sm primary', { fk: 'start:' + n, aria: 'Start ' + n, disabled: busy, onClick: (b) => runTask('/api/vm/start', { name: n }, { btn: b }) }));
    } else if (isUp(v) || v.status === 'stopping') {
      out.push(btn('Stop', 'sm', { fk: 'stop:' + n, aria: 'Stop ' + n, disabled: busy || v.status === 'stopping', onClick: (b) => runTask('/api/vm/stop', { name: n }, { btn: b }) }));
    } else if (v.status === 'missing') {
      out.push(btn('Remove record', 'sm danger-outline', { fk: 'forget:' + n, aria: 'Remove the record of ' + n, disabled: busy, onClick: () => forgetVm(n) }));
    }
    out.push(btn('Manage', 'sm', { fk: 'manage:' + n, aria: 'Manage ' + n, onClick: () => selectVm(n) }));
    return out;
  }

  async function forgetVm(name) {
    if (!await confirmDialog('Remove the record of "' + name + '"?',
      'The disk file of this VM is gone. This removes the VM from the list; nothing else is deleted.', 'Remove record')) return;
    try {
      await post('/api/vm/forget', { name: name });
      toast('Removed "' + name + '" from the list', 'ok');
      if (CURRENT === name) closeDetail();
      pokePoll(0);
    } catch (e) { toastError(e); }
  }

  async function deleteTempVms(b) {
    const temps = Array.from(VMS.values()).filter((v) => v.ephemeral);
    if (!temps.length) return;
    const ok = await confirmDialog('Delete all ' + temps.length + ' temporary VM' + (temps.length === 1 ? '' : 's') + '?',
      'These VMs and their disks are removed permanently (running ones are shut down first):\n\n'
      + temps.map((v) => '  ' + v.name + (v.status !== 'stopped' ? '  (' + (STATUS_TEXT[v.status] || v.status) + ')' : '')).join('\n'),
      'Delete ' + temps.length + ' VM' + (temps.length === 1 ? '' : 's'));
    if (!ok) return;
    const undo = busyButton(b);
    const failed = [];
    const done = await Promise.all(temps.map((v) => runTask('/api/vm/delete', { name: v.name }, {
      quiet: true, onError: (e) => failed.push(v.name + ': ' + e.message),
    })));
    undo();
    for (let i = 0; i < done.length; i++) {
      if (done[i] && done[i].status !== 'done') failed.push(temps[i].name + ': ' + firstLine(done[i].error));
    }
    const deleted = done.filter((t) => t && t.status === 'done').length;
    if (failed.length) toast('Deleted ' + deleted + ' of ' + temps.length + ' temporary VMs. Not deleted:\n' + failed.join('\n'), 'err');
    else toast('Deleted ' + deleted + ' temporary VM' + (deleted === 1 ? '' : 's'), 'ok');
    pokePoll(0);
  }

  // ===========================================================================
  // VM detail panel - keyed by VM (UI-3)
  // ===========================================================================
  let CURRENT = null;
  let TAB = 'overview';
  const TABS = ['overview', 'settings', 'docker', 'network', 'terminal', 'serial', 'screen'];
  // the tab an appliance VM (any OS with a screen) does not have; its Terminal
  // logs in to the guest's own SSH server with the guest's account
  const NOT_APPLIANCE_TABS = ['docker'];
  const isAppliance = (v) => !!(v && v.kind === 'appliance');

  function selectVm(name, tab) {
    if (!VMS.has(name)) { toast('There is no VM called "' + name + '"', 'err'); return; }
    const changed = name !== CURRENT;
    if (changed) {
      leaveVm();
      CURRENT = name;
      enterVm(VMS.get(name));
    }
    $('#detail').hidden = false;
    showTab(tab || (changed ? 'overview' : TAB));
    renderDetail();
    for (const r of VMROWS.values()) {
      r.tr.classList.toggle('sel', r.name === CURRENT);
      if (r.name === CURRENT) r.tr.setAttribute('aria-current', 'true'); else r.tr.removeAttribute('aria-current');
    }
    if (changed || tab) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  // Everything that belonged to the previous VM goes: its terminal sessions,
  // the log timer, Docker data, half-typed forms (UI-3, UI-4, UI-16).
  function leaveVm() {
    sshView.disconnect(true);
    serialView.disconnect(true);
    screenView.disconnect(true);
    stopLogView();
    resetDocker();
    resetSettingsForms();
    NET.key = '';
    OV.key = '';
    SNAP.key = '';
  }
  function enterVm(v) {
    fillSettings(v, true);
    fillPorts(v.ports || [], true);
    $('#tUser').value = 'root';
    const appl = isAppliance(v);
    $('#tStdLogin').hidden = appl;
    $('#tApLogin').hidden = !appl;
    $('#tApHint').hidden = !appl;
    $('#sApBlock').hidden = !appl;
    $('#tApUser').value = appl ? ((v.appliance && v.appliance.sshUser) || 'root') : '';
    $('#tApPass').value = '';
  }
  function closeDetail() {
    leaveVm();
    CURRENT = null;
    $('#detail').hidden = true;
    for (const r of VMROWS.values()) { r.tr.classList.remove('sel'); r.tr.removeAttribute('aria-current'); }
  }

  function tabsFor(v) {
    return TABS.filter((t) => (isAppliance(v) ? NOT_APPLIANCE_TABS.indexOf(t) === -1 : t !== 'screen'));
  }
  function showTab(which) {
    const v = CURRENT ? VMS.get(CURRENT) : null;
    const tabs = tabsFor(v);
    if (tabs.indexOf(which) === -1) which = 'overview';
    const prev = TAB;
    TAB = which;
    for (const t of TABS) {
      const on = t === which;
      const b = $('#tab-' + t);
      b.hidden = tabs.indexOf(t) === -1;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      $('#p-' + t).hidden = !on;
    }
    if (which === 'screen') screenView.shown();
    if (prev === 'serial' && which !== 'serial') stopLogTimer();
    if (which === 'docker') loadDocker(false);
    if (which === 'network') loadNetwork(true);
    if (which === 'settings') loadShareStatus(true);
    if (which === 'terminal') sshView.shown();
    if (which === 'serial') { serialView.shown(); if (LOGVIEW.open) { refreshLog(true); startLogTimer(); } }
  }
  function onTabKey(e) {
    const tabs = tabsFor(CURRENT ? VMS.get(CURRENT) : null);
    const i = tabs.indexOf(TAB);
    let n = null;
    if (e.key === 'ArrowRight') n = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') n = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') n = tabs[0];
    else if (e.key === 'End') n = tabs[tabs.length - 1];
    if (!n) return;
    e.preventDefault();
    showTab(n);
    $('#tab-' + n).focus();
  }

  // Buttons that start work on the VM: disabled while a task holds the VM,
  // so a second click cannot produce a "busy" error (UI-11).
  const VM_WORK_BUTTONS = ['#ovStart', '#ovStop', '#ovRestart', '#ovForce', '#sSave', '#sRestartNow', '#pSave',
    '#dkResize', '#dkGrow', '#dkCompact', '#snapCreate', '#fzGo', '#vReset', '#vDelete',
    '#dpGo', '#dpInspect', '#rnGo', '#plGo', '#cpGo', '#shAdd'];

  function renderDetail() {
    if (!CURRENT) return;
    const v = VMS.get(CURRENT);
    if (!v) { closeDetail(); return; } // deleted (here or elsewhere)
    const titleKey = v.name + '|' + v.status + '|' + !!v.busy + '|' + [v.ephemeral, v.createdBy, v.autostart, v.pendingRestart].join();
    if ($('#dTitle').dataset.key !== titleKey) {
      $('#dTitle').dataset.key = titleKey;
      setChildren($('#dTitle'), v.name);
      setChildren($('#dBadges'), statusPill(v), vmTags(v));
    }
    renderOverview(v);
    renderSettingsLive(v);
    renderSnapshots(v);
    renderShares(v);
    if (TAB === 'settings') loadShareStatus(false);
    // Force stop stays usable while a start waits for a guest that may hang
    // (up to 240 s, 600 s under TCG) or a normal stop waits for its power-off:
    // the manager cancels that wait for a force stop (XTR-1)
    const busyTask = v.busy ? TASKS.byId.get(v.busy) : null;
    const forceable = !!(busyTask && /^(start|restart|create|quickdeploy|reset|stop)$/.test(busyTask.kind) && !/^Force stop/.test(busyTask.title || ''));
    for (const sel of VM_WORK_BUTTONS) {
      const el = $(sel);
      if (el.getAttribute('aria-busy') === 'true') continue;
      el.disabled = sel === '#ovForce' && forceable ? false : (!!v.busy || extraDisabled(sel, v));
    }
    sshView.updateButtons();
    serialView.updateButtons();
    screenView.updateButtons();
    // the tab strip follows the kind (an appliance has a screen, no SSH tabs)
    if ($('#tab-screen').hidden === !isAppliance(v)) showTab(TAB);
    const hasLog = !!v.hasLog;
    $('#scLogToggle').disabled = !hasLog && !LOGVIEW.open;
    $('#scLogDownload').disabled = !hasLog;
    if (TAB === 'network') loadNetwork(false);
    if (TAB === 'docker' && (Date.now() - DOCK.lastLoad > 15000 || DOCK.vmStatus !== v.status)) loadDocker(false);
    DOCK.vmStatus = v.status;
  }
  // State rules the manager enforces anyway; disabling saves a round trip.
  function extraDisabled(sel, v) {
    const up = isUp(v), missing = v.status === 'missing';
    switch (sel) {
      case '#dkResize': case '#fzGo': case '#snapCreate': return up || missing;
      case '#dkGrow': return v.status !== 'running';
      case '#dkCompact': case '#shAdd': return missing;
      case '#vReset': return missing || v.template === ''; // a standalone disk has no template to go back to
      case '#dpGo': case '#dpInspect': case '#rnGo': case '#plGo': case '#cpGo': return v.status !== 'running';
      case '#sRestartNow': return !up;
      default: return false;
    }
  }

  // ---- overview (refreshed on every poll - UI-15) ----
  const OV = { key: '', upEl: null };
  function renderOverview(v) {
    const up = isUp(v);
    $('#ovStart').hidden = !(v.status === 'stopped' || v.status === 'error');
    $('#ovStop').hidden = !(up || v.status === 'stopping');
    $('#ovRestart').hidden = !up;
    $('#ovForce').hidden = !(up || v.status === 'stopping');
    $('#ovTerminal').disabled = v.status !== 'running';
    setText($('#ovTerminal'), isAppliance(v) ? 'Open screen' : 'Open terminal');
    // an appliance: switch between the browser view and a window on this PC
    const inWindow = isAppliance(v) && v.appliance && v.appliance.display === 'window';
    $('#ovDisplay').hidden = !isAppliance(v) || v.status === 'missing';
    setText($('#ovDisplay'), (up ? (inWindow ? 'Show in the browser' : 'Open in a window') : (inWindow ? 'Start in the browser' : 'Start in a window')) + (inWindow ? '' : ' (3D, full speed)'));
    $('#ovDisplay').disabled = !!v.busy || v.status === 'stopping' || v.status === 'booting';
    $('#ovCopySsh').hidden = false;
    $('#ovEject').hidden = !(isAppliance(v) && v.appliance && v.appliance.media !== 'disk');
    setText($('#ovEject'), isAppliance(v) && v.appliance && v.appliance.media === 'iso' ? 'Remove CD-ROM' : 'Remove installation media');
    $('#ovEject').disabled = isUp(v) || !!v.busy;
    $('#ovForget').hidden = v.status !== 'missing';
    const busyTask = v.busy ? TASKS.byId.get(v.busy) : null;
    const acc = (STATE.platform && STATE.platform.accel) || {};
    // uptime ticks every poll, so it is kept out of the key and updated alone
    const vKey = Object.assign({}, v, { startedAt: null, diskBytes: Math.round((v.diskBytes || 0) / 1048576) });
    const key = JSON.stringify([vKey, busyTask && busyTask.title, busyTask && busyTask.step, acc.recommended, (STATE.settings || {}).accel]);
    if (key !== OV.key) {
      OV.key = key;
      const kids = [];
      const kv = (k, val) => kids.push(h('div', { class: 'k' }, k), h('div', { class: 'v' }, val));
      kv('Status', [statusPill(v), busyTask ? h('span', { class: 'small' }, '  ' + (busyTask.title || 'working') + (busyTask.step ? ': ' + busyTask.step : '')) : null]);
      if (isAppliance(v)) {
        const ap = v.appliance || {};
        kv('Screen', v.window ? [h('b', null, 'a window on this PC'), ' - 3D graphics, full speed (', h('span', { class: 'mono' }, 'QEMU (' + v.name + ')'), ' in the taskbar)']
          : (v.screen ? h('a', { href: '#', class: 'lnk' }, 'open the Screen tab')
            : h('span', { class: 'small' }, ap.display === 'window' ? 'a window on this PC while the VM runs (3D graphics, full speed)' : 'shown while the VM runs (Screen tab)')));
        kv('SSH', [h('span', { class: 'mono' }, v.sshCommand || ''), ' ', exposureTag(v.sshLan),
          h('div', { class: 'small' }, 'the guest\'s own SSH server and account, when it runs one - the Terminal tab logs in with its password')]);
        kv('Firmware / disk / display', (ap.firmware === 'bios' ? 'BIOS (SeaBIOS)' : 'UEFI (edk2)') + ' / ' + (ap.bus === 'sata' ? 'SATA' : 'virtio') + ' / ' + (ap.vga === 'std' ? 'plain VGA' : 'virtio-vga') + (ap.sound ? ', sound on' : ', no sound'));
        kv('Image', h('span', { class: 'mono', title: ap.source || '' }, ap.sourceName || ap.source || ''));
        if (ap.media === 'iso') kv('CD-ROM', h('span', { class: 'badge warn' }, 'the installer ISO is attached - remove it once the OS is installed (button below)'));
        if (ap.media === 'image') kv('Installation media', h('span', { class: 'badge warn' }, 'the image is attached as a second disk and boots first - install onto the empty disk, then remove it (button below)'));
      } else {
        kv('SSH', [h('span', { class: 'mono' }, v.sshCommand || ''), ' ', exposureTag(v.sshLan)]);
      }
      kv('Acceleration', accelLine(v));
      kv('Memory / vCPUs', v.mem + ' MB / ' + v.cpus + ' vCPU');
      kv('Disk on this PC', fmtBytes(v.diskBytes) + (v.virtualSizeBytes ? ' (virtual size ' + fmtBytes(v.virtualSizeBytes) + ')' : ''));
      if (!isAppliance(v)) kv('Template', v.template === null || v.template === undefined ? 'unknown' : (v.template === '' ? 'none (standalone disk)' : v.template));
      kv('Port forwards', portList(v));
      const upEl = h('span', { class: 'mono' });
      kv('Uptime', upEl);
      OV.upEl = upEl;
      if (v.createdAt) kv('Created', fmtDate(v.createdAt) + (v.createdBy ? ' by ' + (/^(mcp|claude)/.test(v.createdBy) ? 'Claude' : v.createdBy) : ''));
      if (v.note) kv('Note', v.note);
      if (v.legacy) kv('Restart now', h('span', { class: 'badge warn' }, 'Started by version 1: its QEMU monitor is reachable from every VM and its ports from the network until you restart it'));
      if (v.pendingRestart) kv('Pending', h('span', { class: 'badge warn' }, 'Changed settings apply the next time the VM starts'));
      if (v.pendingFsResize) kv('Disk', h('span', { class: 'badge warn' }, 'Enlarged - press Grow filesystem (Settings tab) once the VM runs'));
      keepFocusIn($('#ovKv'), () => setChildren($('#ovKv'), kids));
      const lnk = $('#ovKv').querySelector('a.lnk');
      if (lnk) lnk.addEventListener('click', (e) => { e.preventDefault(); showTab('screen'); });
      // last error with QEMU's own words and the serial console tail
      const le = v.lastError;
      $('#ovError').hidden = !le;
      if (le) {
        setText($('#ovErrAt'), le.at ? fmtDate(le.at) : '');
        setText($('#ovErrMsg'), le.message || 'unknown error');
        $('#ovErrDetail').hidden = !le.detail;
        setText($('#ovErrDetail'), le.detail || '');
      }
    }
    if (OV.upEl) setText(OV.upEl, up && v.startedAt ? fmtDur(secondsSince(v.startedAt)) + (v.pid ? '  (QEMU pid ' + v.pid + ')' : '') : '-');
  }
  function accelLine(v) {
    const acc = (STATE.platform && STATE.platform.accel) || {};
    const global = (STATE.settings && STATE.settings.accel) || 'auto';
    // the host probe's choice (test boots) beats what merely starts
    const hp = STATE.hostProbe || {};
    const auto = hp.current && hp.best ? accelName(hp.best.accel) + ' (' + hp.best.label + ', probed)' : (acc.recommended ? accelName(acc.recommended) + ' on this PC' : '');
    const cfg = v.accel && v.accel !== 'auto' ? accelName(v.accel) + ' (set for this VM)'
      : (global !== 'auto' ? accelName(global) + ' (global setting)' : 'Automatic' + (auto ? ' - ' + auto : ''));
    const fb = v.accelFallback ? h('div', { class: 'badge warn' },
      'Runs under TCG since ' + fmtDate(v.accelFallback.at) + ': ' + v.accelFallback.reason + '. Choose an accelerator in Settings to try hardware acceleration again.') : null;
    if (isUp(v) && v.effectiveAccel) {
      return [h('b', null, accelName(v.effectiveAccel)), v.effectiveAccel === 'tcg' ? ' - software emulation, slower' : ' - hardware accelerated',
        h('span', { class: 'small' }, '   configured: ' + cfg), fb];
    }
    return fb ? [cfg, fb] : cfg;
  }
  function portList(v) {
    const ports = v.ports || [];
    if (!ports.length) return h('span', { class: 'small' }, 'none - add them in the Settings tab');
    return ports.map((p) => h('div', null,
      link('http://127.0.0.1:' + p.host + '/', '127.0.0.1:' + p.host),
      ' → VM port ' + p.guest,
      p.container && p.container !== p.guest ? ' → container port ' + p.container : '',
      p.owner ? '  (' + p.owner + ')' : '', ' ', exposureTag(p.lan)));
  }

  // An appliance's screen: the browser view (VNC, the Screen tab) or a window
  // on this PC (3D graphics, full speed). Saved, then the VM is restarted (it
  // runs) or started (it does not): QEMU opens its screen at start only.
  async function switchDisplay(v, to, b) {
    const name = v.name, up = isUp(v);
    const what = to === 'window' ? 'in a window on this PC (3D graphics, full speed)' : 'in the browser (Screen tab)';
    if (up && !await openModal({
      title: 'Restart "' + name + '" to show its screen ' + (to === 'window' ? 'in a window' : 'in the browser') + '?',
      hint: 'The VM is shut down (ACPI power-off, like the power button) and started again with its screen ' + what + '. ' +
        (to === 'window' ? 'The window opens on the PC that runs the manager; the browser view is off meanwhile.' : 'The window closes.'),
      submitLabel: 'Restart',
    })) return;
    const undo = busyButton(b);
    try {
      const r = await post('/api/vm/settings', { name: name, display: to });
      LOCAL_WRITE_AT = Date.now();
      if (r.vm) { VMS.set(name, r.vm); if (name === CURRENT) fillSettings(r.vm, true); }
    } catch (e) {
      undo();
      if (!e.auth) toast('Could not change the screen: ' + e.message, 'err');
      return;
    }
    undo();
    await runTask(up ? '/api/vm/restart' : '/api/vm/start', { name: name }, { btn: b });
    pokePoll(0);
  }

  // ---- settings form: dirty-tracked, sends only what changed (MNT-4) ----
  const SET_FIELDS = {
    mem: { sel: '#sMem', get: (el) => toInt(el.value), set: (el, x) => { el.value = x === null || x === undefined ? '' : String(x); } },
    cpus: { sel: '#sCpu', get: (el) => toInt(el.value), set: (el, x) => { el.value = x === null || x === undefined ? '' : String(x); } },
    accel: { sel: '#sAccel', get: (el) => el.value, set: (el, x) => { el.value = x; } },
    note: { sel: '#sNote', get: (el) => el.value, set: (el, x) => { el.value = x; } },
    autostart: { sel: '#sAuto', get: (el) => el.checked, set: (el, x) => { el.checked = !!x; } },
    ephemeral: { sel: '#sEph', get: (el) => el.checked, set: (el, x) => { el.checked = !!x; } },
    sshLan: { sel: '#sSshLan', get: (el) => el.checked, set: (el, x) => { el.checked = !!x; } },
    // appliance VMs only
    display: { sel: '#sDisplay', appliance: true, get: (el) => el.value, set: (el, x) => { el.value = x; } },
    sshUser: { sel: '#sSshUser', appliance: true, get: (el) => el.value.trim(), set: (el, x) => { el.value = x; } },
  };
  const fieldsFor = (v) => Object.keys(SET_FIELDS).filter((k) => !SET_FIELDS[k].appliance || isAppliance(v));
  let SET_ORIG = {};
  function serverVal(v, k) {
    if (k === 'note') return v.note || '';
    if (k === 'accel') return v.accel || 'auto';
    if (k === 'autostart' || k === 'ephemeral' || k === 'sshLan') return !!v[k];
    if (k === 'display') return (v.appliance && v.appliance.display) || 'browser';
    if (k === 'sshUser') return (v.appliance && v.appliance.sshUser) || 'root';
    return v[k];
  }
  function fillSettings(v, force) {
    syncAccelSelect(v);
    for (const k of fieldsFor(v)) {
      const f = SET_FIELDS[k], el = $(f.sel);
      const server = serverVal(v, k);
      if (force) { f.set(el, server); SET_ORIG[k] = server; continue; }
      const dirty = f.get(el) !== SET_ORIG[k];
      // never overwrite what the user is editing
      if (!dirty && document.activeElement !== el && SET_ORIG[k] !== server) { f.set(el, server); SET_ORIG[k] = server; }
    }
  }
  function syncAccelSelect(v) {
    const sel = $('#sAccel');
    const a = (STATE && STATE.platform && STATE.platform.accel) || {};
    const opts = ['auto'].concat(a.available && a.available.length ? a.available : ['tcg']);
    const want = v.accel || 'auto';
    if (opts.indexOf(want) === -1) opts.push(want);
    const key = opts.join(',') + '|' + (a.recommended || '');
    if (sel.dataset.key === key) return;
    const cur = sel.value;
    sel.dataset.key = key;
    setChildren(sel, opts.map((o) => h('option', { value: o },
      o === 'auto' ? 'Automatic' + (a.recommended ? ' (' + a.recommended.toUpperCase() + ' on this PC)' : '') : accelName(o))));
    sel.value = cur && opts.indexOf(cur) !== -1 ? cur : want;
  }
  function renderSettingsLive(v) {
    const fresh = RENDER_ASKED_AT >= LOCAL_WRITE_AT;
    if (fresh) fillSettings(v, false);
    $('#sPending').hidden = !v.pendingRestart;
    $('#sRestartNow').hidden = !(v.pendingRestart && isUp(v));
    $('#dkPendingFs').hidden = !v.pendingFsResize;
    if (!$('#dkSize').dataset.touched && v.virtualSizeBytes) $('#dkSize').placeholder = String(Math.round(v.virtualSizeBytes / 1073741824));
    // port forwards: reload from the manager unless the user has unsaved edits
    if (!fresh) return;
    if (!PORTS.dirty) fillPorts(v.ports || [], false);
    else if (JSON.stringify(v.ports || []) !== PORTS.srcKey && !PORTS.warned) {
      PORTS.warned = true;
      setText($('#pStatus'), 'The forwards were changed elsewhere (for example by a deploy). Save to replace them with yours, or Undo changes to load the new ones.');
    }
  }
  function resetSettingsForms() {
    SET_ORIG = {};
    for (const id of ['#sErr', '#pErr', '#shErr']) hideErr($(id));
    for (const id of ['#dkSize', '#snapName', '#fzName', '#shHost', '#shGuest']) { $(id).value = ''; delete $(id).dataset.touched; }
    $('#shRo').checked = false;
    setText($('#shStatus'), '');
    SH.key = '';
    SH.status = null;
    SH.statusFor = null;
    SH.last = 0;
    SH.seq++;
    $('#dkSize').placeholder = '';
    setText($('#pStatus'), '');
    PORTS.dirty = false;
    PORTS.srcKey = '';
  }
  async function saveSettings(b) {
    const name = CURRENT, v = VMS.get(name);
    if (!v) return;
    const err = $('#sErr');
    const body = { name: name };
    let changed = 0;
    for (const k of fieldsFor(v)) {
      const val = SET_FIELDS[k].get($(SET_FIELDS[k].sel));
      if (val !== serverVal(v, k)) { body[k] = val; changed++; }
    }
    if (!changed) { hideErr(err); toast('Nothing to save - no setting was changed', 'ok'); return; }
    const bad = checkMemCpu('mem' in body ? body.mem : undefined, 'cpus' in body ? body.cpus : undefined);
    if (bad) return showErr(err, bad, $(bad.indexOf('Memory') === 0 ? '#sMem' : '#sCpu'));
    hideErr(err);
    const undo = busyButton(b);
    try {
      const r = await post('/api/vm/settings', body);
      LOCAL_WRITE_AT = Date.now();
      if (name !== CURRENT) return;
      if (r.vm) { VMS.set(name, r.vm); fillSettings(r.vm, true); }
      const restartNeeded = r.pendingRestart && r.vm && isUp(r.vm);
      toast(restartNeeded ? 'Saved. Memory, vCPUs, acceleration, SSH exposure and the screen apply the next time the VM starts (Restart now).' : 'Settings saved', 'ok');
      pokePoll(0);
    } catch (e) {
      if (!e.auth) showErr(err, e.message);
    } finally {
      undo();
    }
  }

  // ---- port forward rows (per-row LAN choice; keeps deploy metadata - MNT-1) ----
  // base: the server's list the rows were loaded from - sent with a save, so
  // a forward added meanwhile (a deploy, Claude's forward_port) is never
  // closed by an editor opened before it: the manager answers 409 CHANGED
  const PORTS = { rows: [], dirty: false, srcKey: '', warned: false, base: [] };
  function fillPorts(list, force) {
    const key = JSON.stringify(list);
    if (!force && key === PORTS.srcKey) return;
    PORTS.srcKey = key;
    PORTS.base = list.map((p) => ({ host: p.host, guest: p.guest, lan: !!p.lan }));
    PORTS.dirty = false;
    PORTS.warned = false;
    PORTS.rows = list.map((p) => ({
      host: p.host, guest: p.guest, lan: !!p.lan, owner: p.owner || '', container: p.container || null,
      orig: { host: p.host, guest: p.guest },
    }));
    $('#pUndo').disabled = true;
    renderPortRows();
  }
  function markPortsDirty() {
    if (!PORTS.dirty) { PORTS.dirty = true; setText($('#pStatus'), 'Unsaved changes.'); }
    $('#pUndo').disabled = false;
  }
  function renderPortRows() {
    const box = $('#pRows');
    const kids = [h('div', { class: 'ph' }, 'Port on this PC'), h('div', { class: 'ph' }, 'Port in the VM'),
      h('div', { class: 'ph' }, 'Exposure'), h('div', { class: 'ph' }, 'Used by'), h('div', { class: 'ph' }, h('span', { class: 'sr-only' }, 'Remove'))];
    if (!PORTS.rows.length) kids.push(h('div', { class: 'none' }, 'No port forwards. Press "Add port" to reach a service in the VM from this PC.'));
    PORTS.rows.forEach((r, i) => {
      const n = i + 1;
      const host = h('input', { type: 'number', min: 1, max: 65535, inputmode: 'numeric', 'aria-label': 'Port on this PC, row ' + n, data: { fk: 'ph' + i } });
      host.value = r.host === null || r.host === undefined ? '' : String(r.host);
      host.addEventListener('input', () => { r.host = host.value; markPortsDirty(); });
      const guest = h('input', { type: 'number', min: 1, max: 65535, inputmode: 'numeric', placeholder: 'same', 'aria-label': 'Port in the VM, row ' + n, data: { fk: 'pg' + i } });
      guest.value = r.guest === null || r.guest === undefined ? '' : String(r.guest);
      guest.addEventListener('input', () => { r.guest = guest.value; markPortsDirty(); });
      const lan = h('input', { type: 'checkbox', checked: !!r.lan, data: { fk: 'pl' + i } });
      lan.addEventListener('change', () => { r.lan = lan.checked; markPortsDirty(); });
      const owner = r.owner ? r.owner + (r.container ? ' (container port ' + r.container + ')' : '') : '-';
      kids.push(host, guest, h('label', { class: 'chk' }, lan, 'Reachable from LAN'), h('div', { class: 'owner' }, owner),
        btn('Remove', 'sm danger-outline', { aria: 'Remove port forward row ' + n, fk: 'pr' + i, onClick: () => {
          PORTS.rows.splice(i, 1);
          markPortsDirty();
          renderPortRows();
        } }));
    });
    keepFocusIn(box, () => setChildren(box, kids));
  }
  function addPortRow() {
    PORTS.rows.push({ host: '', guest: '', lan: defaultLan(), owner: '', container: null, orig: null });
    markPortsDirty();
    renderPortRows();
    const inputs = $$('input[type=number]', $('#pRows'));
    if (inputs.length >= 2) inputs[inputs.length - 2].focus();
  }
  async function savePorts(b) {
    const name = CURRENT, v = VMS.get(name);
    if (!v) return;
    const err = $('#pErr');
    const out = [], seen = new Set();
    for (let i = 0; i < PORTS.rows.length; i++) {
      const r = PORTS.rows[i], n = i + 1;
      const host = toInt(r.host);
      const graw = String(r.guest === null || r.guest === undefined ? '' : r.guest).trim();
      const guest = graw === '' ? host : toInt(graw);
      if (!isPort(host)) return showErr(err, 'Row ' + n + ': the port on this PC must be a number from 1 to 65535.');
      if (!isPort(guest)) return showErr(err, 'Row ' + n + ': the port in the VM must be a number from 1 to 65535.');
      if (host === v.port) return showErr(err, 'Row ' + n + ': ' + host + ' is the SSH port of this VM.');
      if (seen.has(host)) return showErr(err, 'Port ' + host + ' on this PC is used by two rows.');
      seen.add(host);
      const m = { host: host, guest: guest, lan: !!r.lan };
      // an unchanged row keeps what a deploy recorded about it
      if (r.orig && r.orig.host === host && r.orig.guest === guest) {
        if (r.owner) m.owner = r.owner;
        if (r.container) m.container = r.container;
      }
      out.push(m);
    }
    hideErr(err);
    const undo = busyButton(b);
    try {
      const res = await post('/api/vm/ports', { name: name, ports: out, base: PORTS.base });
      LOCAL_WRITE_AT = Date.now();
      if (name !== CURRENT) return;
      fillPorts(res.ports || [], true);
      const how = res.applied === 'live' ? 'Saved and applied - the forwards work now.'
        : (res.applied === 'restart' ? 'Saved - restart the VM to apply them.' : 'Saved - they apply when the VM starts.');
      setChildren($('#pStatus'), how, (res.warnings || []).map((w) => h('div', null, 'Note: ' + w)));
      toast('Port forwards saved', 'ok');
      pokePoll(0);
    } catch (e) {
      // CHANGED: someone else changed the forwards since this list was
      // loaded - what the user typed stays, "Undo changes" loads the new list
      if (!e.auth) showErr(err, e.code === 'CHANGED' ? e.message + ' ("Undo changes" loads the current list.)' : e.message);
    } finally {
      undo();
    }
  }

  // ---- snapshots ----
  const SNAP = { key: '' };
  function renderSnapshots(v) {
    const list = Array.isArray(v.snapshots) ? v.snapshots : [];
    const key = JSON.stringify([list, isUp(v), !!v.busy]);
    if (key === SNAP.key) return;
    SNAP.key = key;
    const box = $('#snapList');
    if (!list.length) { setChildren(box, h('div', { class: 'empty' }, 'No snapshots yet.')); return; }
    const locked = isUp(v) || !!v.busy;
    keepFocusIn(box, () => setChildren(box, h('div', { class: 'tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Snapshot'), h('th', { scope: 'col' }, 'Taken'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
      h('tbody', null, list.map((sn) => h('tr', null,
        h('td', { class: 'mono' }, sn.name || ''),
        h('td', { class: 'mono' }, sn.date ? fmtDate(sn.date) || sn.date : '-'),
        h('td', null, h('div', { class: 'btns' },
          btn('Revert', 'sm danger-outline', { fk: 'snr:' + sn.name, aria: 'Revert to snapshot ' + sn.name, disabled: locked, onClick: (b) => snapshotAction(b, 'revert', sn.name) }),
          btn('Delete', 'sm', { fk: 'snd:' + sn.name, aria: 'Delete snapshot ' + sn.name, disabled: locked, onClick: (b) => snapshotAction(b, 'delete', sn.name) }))))))))));
    if (locked && isUp(v)) box.appendChild(h('div', { class: 'hint' }, 'Stop the VM to revert to or delete a snapshot.'));
  }
  async function snapshotAction(b, action, snap) {
    const name = CURRENT;
    if (!name) return;
    if (action === 'revert' && !await confirmDialog('Revert "' + name + '" to the snapshot "' + snap + '"?',
      'The disk goes back to how it was when the snapshot was taken. Everything changed since then is lost.', 'Revert')) return;
    if (action === 'delete' && !await confirmDialog('Delete the snapshot "' + snap + '"?',
      'The VM itself is not changed; you just cannot go back to this point any more.', 'Delete snapshot')) return;
    runTask('/api/vm/snapshot', { name: name, action: action, snapshot: snap }, { btn: b });
  }
  function createSnapshot(b) {
    const name = CURRENT;
    const snap = $('#snapName').value.trim();
    if (!RE.vm.test(snap)) { toast('Snapshot name: use letters, digits, ".", "_" or "-", starting with a letter or digit', 'err'); $('#snapName').focus(); return; }
    runTask('/api/vm/snapshot', { name: name, action: 'create', snapshot: snap }, { btn: b, onAccepted: () => { $('#snapName').value = ''; } });
  }

  // ---- shared folders (SPEC-shares section 6) ----
  // The list comes with /api/state (vm.shares, never a secret); the live
  // status (mounted? why did the last mount end?) from GET /api/shares,
  // fetched only while the Settings tab is visible.
  const SH = { key: '', status: null, statusFor: null, problem: null, last: 0, busy: false, seq: 0, na: false };
  function shareStatusOf(share) {
    if (!SH.status || SH.statusFor !== CURRENT) return null;
    return SH.status.get(share.id) || SH.status.get('g:' + share.guestPath) || null;
  }
  // One chip per share from GET /api/shares: status is 'mounted' |
  // 'pending' (the mount waits for SSH) | 'not-mounted' | 'unavailable'
  // (the folder could not be offered) | 'stopped'.
  function shareChipFor(st, running) {
    if (!running) return h('span', { class: 'chip', title: 'Mounted when it starts' }, 'not running');
    if (!st) return h('span', { class: 'chip' }, SH.na ? 'status not available' : 'status unknown');
    const status = typeof st.status === 'string' ? st.status : (st.mounted ? 'mounted' : 'not-mounted');
    if (status === 'mounted') {
      return h('span', { class: 'chip ok', title: (st.connections || 1) + ' connection(s)' + (Number.isFinite(st.openFiles) ? ', ' + st.openFiles + ' open file(s)' : '') }, 'mounted');
    }
    if (status === 'pending') return h('span', { class: 'chip warn', title: 'Mounted as soon as it answers over SSH' }, 'mounting...');
    if (status === 'unavailable') return h('span', { class: 'chip err', title: 'The folder could not be offered - does it still exist?' }, 'unavailable');
    if (status === 'stopped') return h('span', { class: 'chip' }, 'not running');
    return h('span', { class: 'chip warn' }, 'not mounted');
  }
  function shareChip(v, share) {
    return shareChipFor(shareStatusOf(share), isUp(v));
  }
  // why the last mount of this share ended (the 9P server's close reason)
  function closeReasonOf(st) {
    const last = st && st.lastClose && typeof st.lastClose === 'object' ? st.lastClose
      : (st && Array.isArray(st.recentCloses) && st.recentCloses.length ? st.recentCloses[st.recentCloses.length - 1] : null);
    if (!last || !last.reason) return null;
    return 'Last mount ended' + (last.at ? ' ' + ago(last.at) : '') + ': ' + String(last.reason).slice(0, 300);
  }
  function renderShares(v) {
    const list = Array.isArray(v.shares) ? v.shares : [];
    const mine = SH.statusFor === v.name;
    const key = JSON.stringify([v.name, v.status, !!v.busy, list, mine && SH.status ? Array.from(SH.status.entries()) : null, mine ? SH.problem : null, SH.na]);
    if (key === SH.key) return;
    SH.key = key;
    const box = $('#shRows');
    if (!list.length) {
      keepFocusIn(box, () => setChildren(box, h('div', { class: 'empty' }, 'No shared folders.')));
    } else {
      keepFocusIn(box, () => setChildren(box, h('div', { class: 'shlist' }, list.map((s, i) => {
        const why = isUp(v) ? closeReasonOf(shareStatusOf(s)) : null;
        return h('div', { class: 'shrow' },
          h('div', { class: 'paths' }, h('span', { class: 'mono' }, s.hostPath || ''), ' → ', h('span', { class: 'mono' }, s.guestPath || ''),
            s.readOnly ? h('span', { class: 'tag' }, 'read-only') : null),
          shareChip(v, s),
          btn('Remove', 'sm danger-outline', { fk: 'shr' + i, aria: 'Stop sharing ' + (s.hostPath || '') + ' at ' + (s.guestPath || ''), disabled: !!v.busy, onClick: (b) => removeShare(b, s) }),
          why ? h('div', { class: 'why' }, why) : null);
      })), mine && SH.problem && isUp(v) ? h('div', { class: 'field-error' }, 'Problem: ' + String(SH.problem).slice(0, 400)) : null));
    }
  }
  async function loadShareStatus(force) {
    const name = CURRENT;
    if (TAB !== 'settings' || !name || document.hidden || SH.busy) return;
    const v = VMS.get(name);
    if (!v || !(v.shares || []).length || !isUp(v)) return;
    if (!force && Date.now() - SH.last < 5000) return;
    SH.busy = true;
    SH.last = Date.now();
    const seq = SH.seq;
    try {
      const j = await api('/api/shares?owner=' + encodeURIComponent(name));
      if (seq !== SH.seq || name !== CURRENT) return;
      const m = new Map();
      for (const s of Array.isArray(j.shares) ? j.shares : []) {
        if (!s || typeof s !== 'object') continue;
        if (s.id) m.set(s.id, s);
        if (s.guestPath) m.set('g:' + s.guestPath, s);
      }
      SH.status = m;
      SH.statusFor = name;
      SH.problem = typeof j.problem === 'string' && j.problem ? j.problem : null;
      SH.na = false;
    } catch (e) {
      if (seq !== SH.seq || e.auth) return;
      if (notImpl(e)) SH.na = true;
    } finally {
      SH.busy = false;
    }
    const cur = VMS.get(CURRENT);
    if (cur && seq === SH.seq) renderShares(cur);
  }
  const hostPathProblem = (p) => (!p ? 'Choose the folder on this PC (Browse...).'
    : (/^([A-Za-z]:[\\/]|\\\\|\/)/.test(p) ? null : 'The folder on this PC must be a full path, e.g. C:\\Users\\me\\project.'));
  const guestPathProblem = (p) => (!p ? 'Enter the path in the VM, e.g. /mnt/project.'
    : (/^\/[^\0\n\r]*$/.test(p) && p !== '/' ? null : 'The path in the VM must be an absolute path such as /mnt/project.'));
  async function addShare(b) {
    const name = CURRENT, err = $('#shErr');
    const hostPath = $('#shHost').value.trim(), guestPath = $('#shGuest').value.trim();
    const why = hostPathProblem(hostPath) || guestPathProblem(guestPath);
    if (why) return showErr(err, why, hostPathProblem(hostPath) ? $('#shHost') : $('#shGuest'));
    hideErr(err);
    const undo = busyButton(b);
    try {
      const r = await postMaybeTask('/api/vm/shares', { name: name, action: 'add', hostPath: hostPath, guestPath: guestPath, readOnly: $('#shRo').checked });
      if (name !== CURRENT) return;
      $('#shHost').value = '';
      $('#shGuest').value = '';
      $('#shRo').checked = false;
      // live: mounted now, or waiting for the VM's SSH (pending)
      const how = r.applied === 'live' ? (r.mounted === false && r.pending ? 'Saved - it is mounted as soon as the VM answers over SSH.'
        : (r.mounted === false ? 'Saved, but it is not mounted yet - see its status above.' : 'Shared - the folder is mounted in the VM now.'))
        : (r.applied === 'next-start' ? 'Saved - the folder is mounted when the VM starts.' : 'Saved.');
      setChildren($('#shStatus'), how, (Array.isArray(r.warnings) ? r.warnings : []).map((w) => h('div', null, 'Note: ' + w)));
      toast('Shared folder added', 'ok');
      SH.last = 0;
      pokePoll(0);
    } catch (e) {
      if (!e.auth && name === CURRENT) showErr(err, notImpl(e) ? 'Shared folders are not available in this version of the manager yet.' : e.message);
    } finally {
      undo();
    }
  }
  async function removeShare(b, share) {
    const name = CURRENT, v = VMS.get(name);
    if (!v) return;
    if (!await confirmDialog('Stop sharing this folder with "' + name + '"?',
      share.hostPath + '  →  ' + share.guestPath + '\n\nThe folder on this PC and its files stay as they are; the VM just no longer sees them'
      + (isUp(v) ? ' (it is unmounted now - close programs in the VM that use it first).' : '.'), 'Stop sharing')) return;
    const undo = busyButton(b);
    try {
      const r = await postMaybeTask('/api/vm/shares', { name: name, action: 'remove', guestPath: share.guestPath });
      if (name !== CURRENT) return;
      setChildren($('#shStatus'), r.applied === 'live' && r.unmounted === false ? 'Removed - the VM still had it mounted; it is gone after the next restart.' : 'Removed.',
        (Array.isArray(r.warnings) ? r.warnings : []).map((w) => h('div', null, 'Note: ' + w)));
      toast('Shared folder removed', 'ok');
      pokePoll(0);
    } catch (e) {
      if (!e.auth) toast(notImpl(e) ? 'Shared folders are not available in this version of the manager yet.' : e.message, 'err');
    } finally {
      undo();
    }
  }
  async function browseInto(input) {
    const p = await pickFolder(input.value.trim());
    if (p) { input.value = p; input.dataset.touched = '1'; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); }
  }

  // ---- disk, freeze, reset, delete ----
  function resizeDisk(b) {
    const L = limits();
    const n = toInt($('#dkSize').value);
    if (n === null || n < L.minDiskGB || n > L.maxDiskGB) {
      toast('Enter the new disk size: a number from ' + L.minDiskGB + ' to ' + L.maxDiskGB + ' GB', 'err');
      $('#dkSize').focus();
      return;
    }
    // disks only grow: shrinking would cut off the filesystem
    const v = VMS.get(CURRENT);
    const cur = v && v.virtualSizeBytes ? v.virtualSizeBytes / 1073741824 : 0;
    if (cur && n <= cur) {
      toast('The disk is already ' + fmtBytes(v.virtualSizeBytes) + ' - enter a larger size (disks can only grow)', 'err');
      $('#dkSize').focus();
      return;
    }
    runTask('/api/vm/resize', { name: CURRENT, sizeGB: n }, { btn: b });
  }
  function freezeVm(b) {
    const as = $('#fzName').value.trim();
    if (as && vmNameProblem(as)) { toast('Template name: ' + vmNameProblem(as), 'err'); $('#fzName').focus(); return; }
    const body = { name: CURRENT };
    if (as) body.as = as;
    runTask('/api/vm/freeze', body, { btn: b, onAccepted: () => { $('#fzName').value = ''; } });
  }
  async function resetVm(b) {
    const name = CURRENT, v = VMS.get(name);
    if (!v) return;
    if (!await confirmDialog('Reset "' + name + '" to its template?',
      'The disk is recreated from the template' + (v.template ? ' "' + v.template + '"' : '') + ': everything installed or changed inside the VM is lost. '
      + 'Its settings and port forwards are kept' + (isUp(v) ? ', and it starts again afterwards.' : '.'), 'Reset')) return;
    runTask('/api/vm/reset', { name: name }, { btn: b });
  }
  async function deleteVm(b) {
    const name = CURRENT, v = VMS.get(name);
    if (!v) return;
    if (!await confirmDialog('Delete the VM "' + name + '"?',
      'Its disk is removed permanently' + (isUp(v) ? ' (it is shut down first)' : '') + '. This cannot be undone. Templates and other VMs are not affected.', 'Delete VM')) return;
    const t = await runTask('/api/vm/delete', { name: name }, { btn: b });
    // only a delete that worked closes the panel (UI-17)
    if (t && t.status === 'done' && CURRENT === name) closeDetail();
  }
  async function forceStop(b) {
    const name = CURRENT;
    if (!await confirmDialog('Force stop "' + name + '"?',
      'This is like pulling the power plug: the VM gets no chance to shut down cleanly, and unsaved data inside it can be lost. Use Stop unless the VM hangs.', 'Force stop')) return;
    runTask('/api/vm/stop', { name: name, force: true }, { btn: b });
  }

  // ===========================================================================
  // Docker tab: data tables refresh, forms are never re-rendered (UI-8)
  // ===========================================================================
  const DOCK = { seq: 0, key: '', lastLoad: 0, loading: false, vmStatus: null };
  const DOCKER_FORM_TEXT = ['#dpImg', '#dpCName', '#dpPorts', '#dpEnv', '#dpVols', '#rnImg', '#rnName', '#rnPorts', '#rnEnv', '#rnVols', '#plImg', '#cpProject', '#cpYaml', '#cpFile'];
  function resetDocker() {
    DOCK.seq++;
    DOCK.key = '';
    DOCK.lastLoad = 0;
    DOCK.loading = false;
    DOCK.vmStatus = null;
    setChildren($('#dockData'), h('div', { class: 'empty' }, 'Loading...'));
    $('#dockForms').hidden = true;
    setText($('#dockStatus'), '');
    for (const id of DOCKER_FORM_TEXT) $(id).value = '';
    $('#dpPreset').value = '';
    $('#rnRestart').value = '';
    $('#dpPriv').checked = false;
    $('#dpHostNet').checked = false;
    delete $('#dpLan').dataset.touched;
    $('#dpLan').checked = defaultLan();
    setChildren($('#dpInfo'));
  }
  async function loadDocker(force) {
    const name = CURRENT;
    if (!name || TAB !== 'docker' || document.hidden) return;
    if (DOCK.loading && !force) return;
    const seq = ++DOCK.seq;
    DOCK.loading = true;
    DOCK.lastLoad = Date.now();
    if (!DOCK.key) setText($('#dockStatus'), 'Reading the Docker state of ' + name + '...');
    try {
      const d = await api('/api/vm/docker?name=' + encodeURIComponent(name));
      // an answer for another VM, or an older request, is dropped (UI-3)
      if (seq !== DOCK.seq || name !== CURRENT) return;
      renderDocker(name, d);
    } catch (e) {
      if (seq !== DOCK.seq || name !== CURRENT || e.auth) return;
      setText($('#dockStatus'), 'Could not read the Docker state: ' + e.message);
    } finally {
      if (seq === DOCK.seq) DOCK.loading = false;
    }
  }
  function renderDocker(name, d) {
    const box = $('#dockData');
    if (!d.installed) {
      const forms = $('#dockForms');
      // SSH did not answer this one time (a busy guest under TCG): once the
      // forms were shown for this VM they stay, with the tables, the Inspect
      // result and what the user is typing - only the status line says so
      // (UI-8). resetDocker() hides them when the VM changes.
      if (d.note === 'booting' && !forms.hidden) {
        setText($('#dockStatus'), 'The VM did not answer over SSH just now - retrying...');
        return;
      }
      // never pull the forms away from under the user's fingers
      if (!forms.contains(document.activeElement)) forms.hidden = true;
      setText($('#dockStatus'), '');
      const key = 'none|' + d.running + '|' + d.note;
      if (key === DOCK.key) return;
      DOCK.key = key;
      if (!d.running || d.note === 'stopped') setChildren(box, h('div', { class: 'empty' }, 'Start the VM to use Docker in it.'));
      else if (d.note === 'booting') setChildren(box, h('div', { class: 'empty' }, 'The VM is still booting - Docker can be managed once SSH is up.'));
      else {
        // cliInstalled: the docker command exists but the daemon did not
        // answer; "Install Docker" then just starts it
        const text = d.cliInstalled ? 'Docker is installed in this VM but not running.' : 'Docker is not installed in this VM.';
        setChildren(box, h('div', { class: 'empty' }, text),
          btn(d.cliInstalled ? 'Start Docker' : 'Install Docker', 'sm primary', { fk: 'dinstall', onClick: (b) => runTask('/api/vm/docker/install', { name: name }, { btn: b }) }));
      }
      return;
    }
    $('#dockForms').hidden = false;
    const cs = d.containers || [], is = d.images || [], ns = d.networks || [], vs = d.volumes || [];
    setText($('#dockStatus'), 'Docker ' + (d.version || '') + ' · ' + cs.length + ' container' + (cs.length === 1 ? '' : 's') + ' · ' + is.length + ' image' + (is.length === 1 ? '' : 's'));
    const key = JSON.stringify([cs, is, ns, vs]);
    if (key === DOCK.key) return; // unchanged: leave the tables (and focus) alone
    DOCK.key = key;
    keepFocusIn(box, () => setChildren(box, dockerTables(name, cs, is, ns, vs)));
  }
  function dockerTables(name, cs, is, ns, vs) {
    const out = [h('h3', null, 'Containers')];
    if (!cs.length) out.push(h('div', { class: 'empty' }, 'No containers.'));
    else {
      out.push(h('div', { class: 'tablewrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Name', 'Image', 'State', 'Ports'].map((x) => h('th', { scope: 'col' }, x)), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
        h('tbody', null, cs.map((c) => h('tr', null,
          h('td', null, h('b', null, c.name || c.id || '')),
          h('td', { class: 'mono' }, c.image || ''),
          h('td', { class: 'mono' }, c.status || c.state || ''),
          h('td', { class: 'mono' }, c.ports || '-',
            // the host forwards this container owns (from a deploy): Open links
            urlLinks(c.urls).length ? h('div', { class: 'urls' }, urlLinks(c.urls)) : null),
          h('td', null, h('div', { class: 'btns' }, containerButtons(name, c)))))))));
    }
    out.push(h('h3', { class: 'mt2' }, 'Images'));
    if (!is.length) out.push(h('div', { class: 'empty' }, 'No images.'));
    else {
      out.push(h('div', { class: 'tablewrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Repository', 'Tag', 'Size', 'Created'].map((x) => h('th', { scope: 'col' }, x)), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
        h('tbody', null, is.map((i) => {
          const ref = i.repo && i.repo !== '<none>' ? i.repo + (i.tag && i.tag !== '<none>' ? ':' + i.tag : '') : (i.id || '');
          return h('tr', null,
            h('td', { class: 'mono' }, i.repo || ''), h('td', { class: 'mono' }, i.tag || ''),
            h('td', { class: 'mono' }, i.size || ''), h('td', { class: 'mono' }, i.created || ''),
            h('td', null, btn('Remove', 'sm danger-outline', { fk: 'rmi:' + ref, aria: 'Remove image ' + ref, disabled: !RE.image.test(ref), onClick: (b) => removeImage(b, name, ref) })));
        })))));
    }
    out.push(h('h3', { class: 'mt2' }, 'Networks and volumes'));
    out.push(h('div', { class: 'mono' },
      ns.map((x) => h('div', null, 'network ' + (x.name || '') + ' (' + (x.driver || '?') + ')')),
      vs.map((x) => h('div', null, 'volume ' + (x.name || '') + (x.driver && x.driver !== 'local' ? ' (' + x.driver + ')' : ''))),
      !ns.length && !vs.length ? 'none' : null));
    return out;
  }
  function containerButtons(name, c) {
    const id = c.name || c.id || '';
    const ok = RE.container.test(id);
    const act = (action) => (b) => runTask('/api/vm/docker/action', { name: name, id: id, action: action }, { btn: b });
    const out = [];
    if (c.running) {
      out.push(btn('Stop', 'sm', { fk: 'cs:' + id, aria: 'Stop ' + id, disabled: !ok, onClick: act('stop') }));
      out.push(btn('Restart', 'sm', { fk: 'cr:' + id, aria: 'Restart ' + id, disabled: !ok, onClick: act('restart') }));
    } else {
      out.push(btn('Start', 'sm primary', { fk: 'cst:' + id, aria: 'Start ' + id, disabled: !ok, onClick: act('start') }));
    }
    out.push(btn('Logs', 'sm', { fk: 'cl:' + id, aria: 'Logs of ' + id, disabled: !ok, onClick: (b) => showContainerLogs(b, name, id) }));
    out.push(btn('Remove', 'sm danger-outline', { fk: 'crm:' + id, aria: 'Remove ' + id, disabled: !ok, onClick: (b) => removeContainer(b, name, id) }));
    return out;
  }
  async function removeContainer(b, name, id) {
    if (!await confirmDialog('Remove the container "' + id + '"?',
      'It is stopped and removed (docker rm -f). Data that is not in a volume is lost. Its port forwards are removed too.', 'Remove container')) return;
    runTask('/api/vm/docker/action', { name: name, id: id, action: 'rm' }, { btn: b });
  }
  async function removeImage(b, name, ref) {
    if (!await confirmDialog('Remove the image "' + ref + '"?',
      'Containers need it to be pulled again (which can take minutes). Images still used by a container cannot be removed.', 'Remove image')) return;
    runTask('/api/vm/docker/rmi', { name: name, image: ref }, { btn: b });
  }
  async function showContainerLogs(b, name, id) {
    const undo = busyButton(b);
    try {
      const j = await api('/api/vm/docker/logs?name=' + encodeURIComponent(name) + '&container=' + encodeURIComponent(id) + '&tail=400');
      textDialog('Logs of ' + id + ' (last 400 lines)', j.text || '(no output)');
    } catch (e) { toastError(e); } finally { undo(); }
  }

  function showResult(box, msg, isErr) {
    setChildren(box, isErr ? h('span', { class: 'field-error' }, msg) : msg);
  }
  function showDeployed(box, prefix, t) {
    const links = urlLinks(t.result && t.result.urls);
    setChildren(box, prefix + (t.result && t.result.container ? ' Container: ' + t.result.container + '.' : ''),
      links.length ? h('div', { class: 'urls' }, 'Open: ', links) : h('div', null, 'No TCP port was forwarded - add one under Ports if the app has a web page.'));
  }
  function deployForm(name) {
    const cname = $('#dpCName').value.trim();
    return {
      name: name, image: $('#dpImg').value.trim(), containerName: cname || undefined,
      ports: $('#dpPorts').value, env: $('#dpEnv').value, volumes: $('#dpVols').value,
      lan: $('#dpLan').checked, privileged: $('#dpPriv').checked, hostNetwork: $('#dpHostNet').checked,
    };
  }
  async function deployImage(b) {
    const name = CURRENT, info = $('#dpInfo');
    const body = deployForm(name);
    const why = imageProblem(body.image) || (body.containerName && !RE.container.test(body.containerName) ? 'Container name: letters, digits, ".", "_" or "-".' : null);
    if (why) { showResult(info, why, true); return; }
    const t = await runTask('/api/vm/docker/deploy', body, {
      btn: b,
      onError: (e) => showResult(info, e.message, true),
      onAccepted: () => showResult(info, 'Deploying ' + body.image + ' - progress is shown under Tasks.'),
    });
    if (!t || name !== CURRENT) return;
    if (t.status === 'done') showDeployed(info, 'Deployed ' + body.image + '.', t);
    else showResult(info, 'The deploy failed: ' + firstLine(t.error), true);
  }
  async function inspectImage(b) {
    const name = CURRENT, info = $('#dpInfo');
    const image = $('#dpImg').value.trim();
    const why = imageProblem(image);
    if (why) { showResult(info, why, true); return; }
    const t = await runTask('/api/vm/docker/inspect', { name: name, image: image }, {
      btn: b, quiet: true,
      onError: (e) => showResult(info, e.message, true),
      onAccepted: () => showResult(info, 'Pulling and inspecting ' + image + '...'),
    });
    if (!t || name !== CURRENT) return;
    if (t.status !== 'done') { showResult(info, 'Could not inspect it: ' + firstLine(t.error), true); return; }
    const i = (t.result && t.result.info) || {};
    const ports = (i.ports || []).map((p) => p.port + '/' + p.proto);
    setChildren(info,
      h('div', null, h('b', null, 'Ports it declares: '), ports.length ? ports.join(', ') : 'none'),
      h('div', null, h('b', null, 'Volumes it declares: '), (i.volumes || []).length ? i.volumes.join(', ') : 'none'),
      (i.ignoredVolumes || []).length ? h('div', { class: 'field-error' }, 'Ignored unsafe volume paths: ' + i.ignoredVolumes.join(', ')) : null,
      h('div', null, 'Press Deploy and the manager forwards the TCP ports, creates those volume folders and starts it.'
        + (ports.length ? '' : ' It declares no ports, so add the one it uses under Ports.')));
  }
  function runContainer(b) {
    const name = CURRENT;
    const image = $('#rnImg').value.trim();
    const cname = $('#rnName').value.trim();
    const why = imageProblem(image) || (cname && !RE.container.test(cname) ? 'Container name: letters, digits, ".", "_" or "-".' : null);
    if (why) { toast(why, 'err'); return; }
    runTask('/api/vm/docker/run', {
      name: name, image: image, containerName: cname || undefined,
      ports: $('#rnPorts').value, env: $('#rnEnv').value, volumes: $('#rnVols').value,
      restart: $('#rnRestart').value || undefined,
    }, { btn: b });
  }
  function pullImage(b) {
    const image = $('#plImg').value.trim();
    const why = imageProblem(image);
    if (why) { toast(why, 'err'); return; }
    runTask('/api/vm/docker/pull', { name: CURRENT, image: image }, { btn: b });
  }
  function loadComposeFile() {
    const f = $('#cpFile').files && $('#cpFile').files[0];
    if (!f) { toast('Choose a .yml file first', 'err'); return; }
    if (f.size > 900 * 1024) { toast('That file is too large (the limit is about 900 KB)', 'err'); return; }
    const r = new FileReader();
    r.onload = () => { $('#cpYaml').value = String(r.result || ''); };
    r.onerror = () => toast('Could not read the file', 'err');
    r.readAsText(f);
  }
  function deployCompose(b) {
    const project = $('#cpProject').value.trim();
    const yaml = $('#cpYaml').value;
    if (!RE.compose.test(project)) { toast('Project name: lowercase letters, digits, "_" or "-", starting with a letter or digit', 'err'); $('#cpProject').focus(); return; }
    if (!yaml.trim()) { toast('Paste or load a docker-compose.yml first', 'err'); $('#cpYaml').focus(); return; }
    runTask('/api/vm/compose', { name: CURRENT, project: project, yaml: yaml }, { btn: b });
  }

  // ===========================================================================
  // Network tab: refreshes while it is visible (UI-10)
  // ===========================================================================
  const NET = { key: '', last: 0, busy: false, data: null };
  async function loadNetwork(force) {
    if (TAB !== 'network' || !CURRENT || document.hidden || NET.busy) return;
    if (!force && Date.now() - NET.last < 5000) return;
    NET.busy = true;
    NET.last = Date.now();
    try {
      const j = await api('/api/network');
      NET.data = j;
      if (TAB === 'network') renderNetwork();
    } catch (e) {
      if (!e.auth) setChildren($('#netTable'), h('div', { class: 'empty' }, 'Could not read the network state: ' + e.message));
    } finally {
      NET.busy = false;
    }
  }
  function renderNetwork() {
    const j = NET.data;
    if (!j) return;
    const only = $('#netOnlyVm').checked;
    const rows = (j.rows || []).filter((r) => !only || r.vm === CURRENT);
    const key = JSON.stringify([rows, only, CURRENT, j.listenersAvailable, lanAddrs()]);
    if (key === NET.key) return;
    NET.key = key;
    const box = $('#netTable');
    if (!rows.length) setChildren(box, h('div', { class: 'empty' }, 'No port forwards.'));
    else {
      setChildren(box, h('div', { class: 'tablewrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Port on this PC', 'VM', 'What', 'Port in the VM', 'Reachable from', 'State', 'PID'].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', null, rows.map((r) => netRow(r, j.listenersAvailable))))));
    }
    const ips = lanAddrs();
    setText($('#netHint'), (ips.length ? 'Forwards marked LAN are reachable from other devices at ' + ips.map((ip) => ip + ':<port>').join(' or ') + '. ' : '')
      + 'Everything else only answers on this PC (127.0.0.1). Change a forward\'s exposure in the Settings tab.');
  }
  function netRow(r, known) {
    const manager = r.kind === 'manager';
    const ctr = r.kind === 'container';
    const what = manager ? 'this manager (web page and API)' : (r.kind === 'bake' ? 'SSH of the base-image build'
      : (r.kind === 'ssh' ? 'SSH' : (ctr ? (r.owner || 'container') + (r.proto === 'udp' ? ' (udp)' : '') : (r.owner ? 'app: ' + r.owner : 'port forward'))));
    let state;
    if (!known) state = h('span', { class: 'small' }, 'unknown');
    else if (!r.listening) state = h('span', { class: 'small' }, 'not listening');
    // a container's forward is held by its own QEMU (byVm may be left out)
    else if (manager || r.byVm || (ctr && r.byVm === undefined)) state = h('span', null, 'listening');
    else state = h('span', { class: 'tag warn', title: 'Another program holds this port - the VM cannot use it' }, 'used by another program');
    return h('tr', { class: r.vm && r.vm === CURRENT ? 'sel' : null },
      h('td', { class: 'mono' }, String(r.host), r.conflict ? h('span', { class: 'tag err', title: 'Two forwards use the same port on this PC' }, 'conflict') : null),
      h('td', null, r.vm || (ctr ? h('span', { class: 'small' }, 'microVM') : '-')),
      h('td', null, what),
      h('td', { class: 'mono' }, r.guest === null || r.guest === undefined ? '-' : String(r.guest) + (r.container && r.container !== r.guest ? ' → container ' + r.container : '')),
      h('td', null, manager ? h('span', { class: 'tag local' }, 'this PC only') : exposureTag(r.lan),
        // QEMU still listens the old way (the choice changed while it ran)
        r.mismatch ? h('span', { class: 'tag warn', title: 'QEMU currently listens ' + (r.scope === 'lan' ? 'on the LAN' : 'on this PC only') + '; restart the VM to apply the new choice' }, 'restart to apply') : null),
      h('td', null, state),
      h('td', { class: 'mono' }, r.pid ? String(r.pid) : '-'));
  }

  // ===========================================================================
  // xterm styles under a strict CSP
  // ===========================================================================
  // xterm's DOM renderer writes its theme colours and cell sizes into style
  // elements it creates. The page's CSP (style-src 'self') blocks those, so
  // their CSS is mirrored into a stylesheet through the CSSOM, which CSP does
  // not restrict: a constructed (adopted) sheet, else rules appended to
  // app.css's own sheet. The baseline rules in app.css cover the rest.
  const XtermCss = (function () {
    const sources = new Map();
    let mode = null, sheet = null, base = 0;
    function init() {
      try {
        if ('adoptedStyleSheets' in document && typeof CSSStyleSheet === 'function') {
          const s = new CSSStyleSheet();
          s.replaceSync('.devbox-probe{color:red}');
          if (s.cssRules.length === 1) {
            document.adoptedStyleSheets = document.adoptedStyleSheets.concat([s]);
            sheet = s;
            mode = 'adopted';
            return;
          }
        }
      } catch (e) { /* not supported */ }
      sheet = Array.from(document.styleSheets).find((s) => s.href && /\/app\.css(\?|$)/.test(s.href)) || null;
      if (sheet) { try { base = sheet.cssRules.length; mode = 'rules'; return; } catch (e) { /* not readable */ } }
      mode = 'none';
    }
    // split "a{..} @keyframes k{50%{..}} b{..}" into top-level rules
    function splitRules(css) {
      const out = [];
      let depth = 0, start = 0;
      for (let i = 0; i < css.length; i++) {
        const c = css[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { out.push(css.slice(start, i + 1).trim()); start = i + 1; } }
      }
      return out.filter(Boolean);
    }
    function apply() {
      const css = Array.from(sources.values()).join('\n');
      if (mode === 'adopted') { try { sheet.replaceSync(css); } catch (e) { /* bad css */ } return; }
      if (mode !== 'rules') return;
      try {
        while (sheet.cssRules.length > base) sheet.deleteRule(sheet.cssRules.length - 1);
        for (const r of splitRules(css)) { try { sheet.insertRule(r, sheet.cssRules.length); } catch (e) { /* skip */ } }
      } catch (e) { /* ignore */ }
    }
    function watch(root) {
      if (!mode) init();
      const scan = () => {
        let changed = false;
        for (const el of $$('style', root)) {
          const t = el.textContent || '';
          if (sources.get(el) !== t) { sources.set(el, t); changed = true; }
        }
        if (changed) apply();
      };
      scan();
      new MutationObserver(scan).observe(root, { childList: true, subtree: true, characterData: true });
      return scan;
    }
    return { watch: watch };
  })();

  // ===========================================================================
  // interactive terminals (SSH and serial console)
  // ===========================================================================
  // One TermView per tab. A session: POST /api/session/open -> {id}; output
  // over Server-Sent Events with a byte offset so a reconnect only replays
  // what was missed (UI-5); input through ONE request at a time carrying
  // everything typed meanwhile, so keystrokes stay in order (UI-23); size
  // sent on open and on every resize (UI-6); closed when the VM changes, the
  // panel closes or the page goes away (UI-4).
  function closeSessionQuietly(id, keepalive) {
    post('/api/session/close', { id: id }, { keepalive: !!keepalive }).catch(() => {});
  }
  const cleanNote = (s) => String(s || '').replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 300);

  class TermView {
    constructor(o) {
      this.kind = o.kind;
      this.mount = $(o.mount);
      this.statusEl = $(o.status);
      this.btnConnect = $(o.connect);
      this.btnDisconnect = $(o.disconnect);
      this.userSel = o.user ? $(o.user) : null;
      this.cmdEl = o.cmd ? $(o.cmd) : null;
      this.term = null;
      this.fitAddon = null;
      this.sess = null;
      this.opening = false;
      this.gen = 0;
      this.resizeTimer = null;
      this.lastStatus = '';
      this.btnConnect.addEventListener('click', () => { if (CURRENT) this.connect(CURRENT); });
      this.btnDisconnect.addEventListener('click', () => this.disconnect(false));
    }
    ensure() {
      if (this.term) return true;
      if (typeof window.Terminal !== 'function') return false;
      this.term = new window.Terminal({
        cursorBlink: true, fontSize: 13, scrollback: 5000,
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        theme: { background: '#0b0d11', foreground: '#c8d0dc', cursor: '#4f8cff', selectionBackground: '#2a3f66' },
        // Links a program in the VM prints (OSC 8 hyperlinks): without this,
        // xterm's default handler uses confirm() and window.open(), and guest
        // output is untrusted - it can dress any address up as harmless text
        linkHandler: { allowNonHttpProtocols: false, activate: (ev, uri) => showGuestLink(uri) },
      });
      if (window.FitAddon && typeof window.FitAddon.FitAddon === 'function') {
        this.fitAddon = new window.FitAddon.FitAddon();
        this.term.loadAddon(this.fitAddon);
      }
      const rescan = XtermCss.watch(this.mount);
      this.term.open(this.mount);
      rescan(); // open() creates its style elements synchronously: mirror them now
      this.term.onData((d) => this.send(d));
      this.term.onResize(() => this.queueResize());
      if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.fit()).observe(this.mount);
      else window.addEventListener('resize', () => this.fit());
      return true;
    }
    fit() {
      if (!this.term || !this.fitAddon || !this.mount.getClientRects().length) return; // hidden: nothing to measure
      try { this.fitAddon.fit(); } catch (e) { /* not rendered yet */ }
    }
    shown() {
      if (this.term) setTimeout(() => this.fit(), 30);
      this.updateButtons();
    }
    setStatus(text, cls) {
      this.lastStatus = text;
      this.statusEl.textContent = text;
      this.statusEl.className = 'tstatus' + (cls ? ' ' + cls : '');
    }
    note(text) {
      if (this.term) this.term.write('\r\n\x1b[90m[' + cleanNote(text) + ']\x1b[0m\r\n');
    }
    live() { return !!(this.sess && !this.sess.ended); }

    async connect(vm) {
      if (this.opening) return;
      if (!this.ensure()) { this.setStatus('The terminal component did not load - reload the page.', 'err'); return; }
      const old = this.sess;
      this.detach(old);
      this.sess = null;
      const gen = ++this.gen;
      this.opening = true;
      this.updateButtons();
      this.fit();
      const body = { name: vm, kind: this.kind, cols: this.term.cols, rows: this.term.rows };
      const tv = VMS.get(vm);
      if (this.kind === 'ssh' && isAppliance(tv)) {
        // the guest's own account; the password goes to this one connection
        body.user = $('#tApUser').value.trim() || (tv.appliance && tv.appliance.sshUser) || 'root';
        if ($('#tApPass').value) body.password = $('#tApPass').value;
      } else if (this.userSel) body.user = this.userSel.value;
      if (old && !old.ended) { old.ended = true; body.replace = old.id; }
      this.setStatus('Connecting...', 'busy');
      let r;
      try {
        r = await post('/api/session/open', body);
      } catch (e) {
        this.opening = false;
        if (gen !== this.gen) return;
        this.updateButtons();
        if (e.auth) return;
        if (e.status === 501) {
          this.setStatus(this.kind === 'serial'
            ? 'The interactive serial console is not available in this version of the manager - use Show boot log.'
            : 'Not available yet: ' + e.message, 'err');
        } else this.setStatus('Could not connect: ' + e.message, 'err');
        return;
      }
      this.opening = false;
      if (gen !== this.gen || vm !== CURRENT) { closeSessionQuietly(r.id); this.updateButtons(); return; } // switched away meanwhile
      const s = {
        id: r.id, vm: vm, since: 0, es: null, ended: false, pending: '', sending: false,
        retries: 0, resizeOk: true, sentSize: body.cols + 'x' + body.rows, timer: null,
      };
      this.sess = s;
      this.term.reset();
      if (this.cmdEl) setText(this.cmdEl, r.command ? 'The same session from a terminal on this PC: ' + r.command : '');
      this.openStream(s);
      this.updateButtons();
      this.term.focus();
    }
    openStream(s) {
      if (s.ended || this.sess !== s) return;
      const url = '/api/session/stream?id=' + encodeURIComponent(s.id) + '&token=' + encodeURIComponent(TOKEN || '') + '&since=' + s.since;
      let es;
      try { es = new EventSource(url); } catch (e) { this.lost(s); return; }
      s.es = es;
      es.onopen = () => {
        if (this.sess !== s) return;
        s.retries = 0;
        this.setStatus('Connected to ' + s.vm + (this.kind === 'serial' ? ' (serial console)' : ''), 'ok');
      };
      es.onmessage = (ev) => {
        if (this.sess !== s) return;
        let j;
        try { j = JSON.parse(ev.data); } catch (e) { return; }
        if (typeof j.t === 'string' && j.t) this.term.write(j.t);
        if (typeof j.n === 'number' && j.n > s.since) s.since = j.n;
        if (j.exit !== undefined) this.ended(s, j.exit);
      };
      // EventSource would reconnect by itself, but with the old ?since= and
      // without telling us; take over: close it and decide what to do.
      es.onerror = () => {
        es.close();
        if (s.es === es) s.es = null;
        if (this.sess === s && !s.ended) this.lost(s);
      };
    }
    lost(s) {
      s.retries++;
      this.setStatus('Connection interrupted - reconnecting...', 'busy');
      clearTimeout(s.timer);
      s.timer = setTimeout(async () => {
        if (this.sess !== s || s.ended) return;
        // Is the session still there? Sending nothing is a cheap check.
        try {
          await post('/api/session/input', { id: s.id, data: '' });
        } catch (e) {
          if (this.sess !== s || s.ended) return;
          if (e.status === 404) { this.ended(s, null, 'The session is gone - the manager restarted or the VM stopped'); return; }
          if (e.auth) { this.ended(s, null, 'Access token needed'); return; }
          if (s.retries > 40) { this.ended(s, null, 'Gave up reconnecting'); return; }
          this.lost(s); // manager not reachable: keep trying
          return;
        }
        this.openStream(s);
      }, Math.min(5000, 600 * s.retries));
    }
    ended(s, code, msg) {
      if (s.ended) return;
      s.ended = true;
      clearTimeout(s.timer);
      if (s.es) { s.es.close(); s.es = null; }
      if (this.sess !== s) return;
      this.note((msg || ('session ended' + (code !== null && code !== undefined ? ' (exit code ' + code + ')' : ''))) + ' - press Connect to start a new one');
      this.setStatus(msg || 'Session ended', msg ? 'err' : '');
      this.updateButtons();
    }
    detach(s) {
      if (!s) return;
      clearTimeout(s.timer);
      if (s.es) { s.es.close(); s.es = null; }
    }
    // reset: the VM changed or the panel closed - also clear the screen
    disconnect(reset) {
      this.gen++;
      this.opening = false;
      const s = this.sess;
      if (s) {
        this.detach(s);
        if (!s.ended) { s.ended = true; closeSessionQuietly(s.id); }
        if (!reset) this.note('disconnected');
      }
      this.sess = null;
      if (reset) {
        if (this.term) this.term.reset();
        if (this.cmdEl) setText(this.cmdEl, '');
      }
      this.setStatus('Not connected');
      this.updateButtons();
    }
    send(d) {
      const s = this.sess;
      if (!s || s.ended) return;
      s.pending += d;
      this.flush(s);
    }
    async flush(s) {
      if (s.sending || !s.pending || s.ended) return;
      s.sending = true;
      const data = s.pending.slice(0, 32768);
      s.pending = s.pending.slice(data.length);
      try {
        await post('/api/session/input', { id: s.id, data: data });
      } catch (e) {
        if (e.status === 404) this.ended(s, null, 'The session has ended');
        else if (!e.auth && this.sess === s) { s.pending = ''; this.note('typing was not delivered: ' + e.message); }
      } finally {
        s.sending = false;
      }
      if (s.pending && !s.ended) this.flush(s);
    }
    queueResize() {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.sendResize(), 250);
    }
    sendResize() {
      const s = this.sess;
      if (!s || s.ended || !s.resizeOk || !this.term) return;
      const size = this.term.cols + 'x' + this.term.rows;
      if (size === s.sentSize) return;
      s.sentSize = size;
      post('/api/session/resize', { id: s.id, cols: this.term.cols, rows: this.term.rows }).then((r) => {
        if (r && r.applied === 'unsupported') s.resizeOk = false; // e.g. no pty name recorded: stop asking
      }, (e) => {
        if (e.status === 501) s.resizeOk = false; // this manager cannot resize yet: stop asking
        else if (e.status === 404) this.ended(s, null, 'The session has ended');
      });
    }
    updateButtons() {
      const v = CURRENT ? VMS.get(CURRENT) : null;
      const live = this.live();
      // serialConsole false while up: the VM was started by v1 (no console
      // socket) and needs one restart
      const noSerial = this.kind === 'serial' && !!v && isUp(v) && v.serialConsole === false;
      const canOpen = !!v && (this.kind === 'serial' ? isUp(v) && !noSerial : v.status === 'running');
      this.btnConnect.disabled = this.opening || live || !canOpen;
      this.btnDisconnect.disabled = !live;
      if (this.userSel) this.userSel.disabled = live || this.opening;
      if (!live && !this.opening && v && !canOpen) {
        const msg = this.kind === 'serial'
          ? (noSerial ? 'This VM was started by an older version of the manager, which had no serial console - restart it once to use it. Show boot log works now.'
            : 'Start the VM to use its serial console.')
          : (v.status === 'booting' ? 'The VM is booting - SSH is not up yet. The Serial console tab works already.' : 'Start the VM to open a terminal.');
        if (this.lastStatus !== msg) { this.setStatus(msg); this.hintShown = true; }
      } else if (canOpen && this.hintShown && !live && !this.opening) {
        // the VM came up: drop the "start the VM" hint
        this.hintShown = false;
        this.setStatus('Not connected');
      }
    }
    // the page is going away: end the session without waiting (keepalive)
    abandon() {
      const s = this.sess;
      if (s && !s.ended) { s.ended = true; this.detach(s); closeSessionQuietly(s.id, true); }
    }
  }

  let sshView = null, serialView = null, screenView = null;

  // ===========================================================================
  // the VM screen (appliance VMs): noVNC through the manager's WebSocket relay
  // ===========================================================================
  // window.DevboxScreen comes from screen.js (an ES module loading noVNC);
  // the connection is closed whenever the VM changes or the page goes away,
  // like the terminals (UI-4). Keyboard input goes to the VM only while the
  // screen has focus (click it).
  class ScreenView {
    constructor() {
      this.conn = null;
      this.name = null;
      this.lastStatus = '';
      this.mount = $('#svScreen');
      $('#svConnect').addEventListener('click', () => { if (CURRENT) this.connect(CURRENT); });
      $('#svDisconnect').addEventListener('click', () => this.disconnect(false));
      $('#svScale').addEventListener('change', () => { if (this.conn) this.conn.setScale($('#svScale').checked); });
      $('#svCad').addEventListener('click', () => {
        if (this.conn) { this.conn.ctrlAltDel(); return; }
        // the window view: through the monitor, like every key from here
        if (CURRENT) post('/api/vm/keys', { name: CURRENT, keys: ['ctrl-alt-delete'] }).catch((e) => { if (!e.auth) toast('Could not send Ctrl+Alt+Del: ' + e.message, 'err'); });
      });
      $('#svToBrowser').addEventListener('click', (e) => { const v = CURRENT ? VMS.get(CURRENT) : null; if (v) switchDisplay(v, 'browser', e.currentTarget); });
      $('#svShot').addEventListener('click', () => this.screenshot());
      $('#svText').addEventListener('click', (e) => this.asText(e.currentTarget));
      $('#svFull').addEventListener('click', () => {
        const w = $('#svWrap');
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else if (w.requestFullscreen) w.requestFullscreen().catch(() => {});
      });
    }
    live() { return !!this.conn; }
    setStatus(s) {
      if (s === this.lastStatus) return;
      this.lastStatus = s;
      setText($('#svStatus'), s);
    }
    connect(name) {
      if (!window.DevboxScreen) { toast('The screen viewer (noVNC) did not load - reload the page', 'err'); return; }
      const v = VMS.get(name);
      if (!v || !v.screen) { this.setStatus('The VM is not running'); return; }
      this.disconnect(true);
      this.name = name;
      this.setStatus('Connecting...');
      try {
        this.conn = window.DevboxScreen.open(this.mount, {
          name: name, token: TOKEN, scale: $('#svScale').checked,
          onStatus: (s) => { this.setStatus(s === 'connected' ? 'Connected - click the screen to type' : s); this.updateButtons(); },
          onDisconnect: (clean) => {
            const was = this.conn;
            this.conn = null;
            this.setStatus(clean ? 'Disconnected' : 'Connection lost' + (VMS.get(name) && !VMS.get(name).screen ? ' - the VM stopped' : ''));
            this.updateButtons();
            if (was) setChildren(this.mount);
          },
        });
      } catch (e) { this.conn = null; this.setStatus('Could not open the screen: ' + (e && e.message)); }
      this.updateButtons();
    }
    disconnect(quiet) {
      const c = this.conn;
      this.conn = null;
      if (c) { c.close(); setChildren(this.mount); }
      if (!quiet) this.setStatus('Disconnected');
      else if (c) this.setStatus('Not connected');
      this.updateButtons();
    }
    shown() {
      const v = CURRENT ? VMS.get(CURRENT) : null;
      if (v && v.screen && !this.conn) this.connect(CURRENT);
      this.updateButtons();
    }
    async screenshot() {
      if (!CURRENT) return;
      try {
        const r = await fetch('/api/vm/screenshot?name=' + encodeURIComponent(CURRENT), { headers: { 'X-DevBox-Token': TOKEN || '' } });
        if (!r.ok) { let j = null; try { j = await r.json(); } catch (e) {} throw new Error((j && j.error) || ('HTTP ' + r.status)); }
        const blob = await r.blob();
        const a = h('a', { href: URL.createObjectURL(blob), download: CURRENT + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png' });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      } catch (e) { toast('Screenshot failed: ' + e.message, 'err'); }
    }
    // the screen read by OCR (Windows): shown in a dialog, copyable
    async asText(b) {
      if (!CURRENT) return;
      const name = CURRENT;
      const undo = busyButton(b);
      let r;
      try { r = await api('/api/vm/screen-text?name=' + encodeURIComponent(name)); }
      catch (e) { toast('Screen as text failed: ' + e.message, 'err'); return; }
      finally { undo(); }   // the spinner stops when the text is there, not when the dialog closes
      const text = r.text || '(no text recognised on the screen)';
      openModal({
        title: 'Screen of "' + name + '" as text',
        hint: 'Read by the OCR built into Windows in ' + r.ms + ' ms - expect small slips (u for v, @ for 0).',
        content: h('pre', { tabindex: '0' }, text),
        submitLabel: 'Copy', cancelLabel: 'Close', wide: true,
        onSubmit: () => { copyText(text, 'the screen text'); return true; },
      });
    }
    updateButtons() {
      const v = CURRENT ? VMS.get(CURRENT) : null;
      const can = !!(v && v.screen);
      // shown in a window on this PC: no browser view, but keys, screenshot and text
      const win = !!(v && v.window);
      $('#svWindowNote').hidden = !win;
      $('#svWrap').hidden = win;
      if (win) setText($('#svWindowTitle'), 'QEMU (' + v.name + ')');
      $('#svToBrowser').disabled = !!(v && v.busy);
      $('#svText').disabled = !(can || win);
      $('#svConnect').disabled = !can || !!this.conn;
      $('#svDisconnect').disabled = !this.conn;
      $('#svCad').disabled = !(this.conn || win);
      $('#svFull').disabled = !this.conn;
      $('#svShot').disabled = !(can || win);
      if (win && !this.conn) this.setStatus('The screen is a window on this PC');
      else if (!can && !this.conn) this.setStatus(v && v.status === 'booting' ? 'Starting...' : 'The VM is not running');
    }
  }

  // ---- serial log viewer (UI-16) ----
  const LOGVIEW = { open: false, timer: null, busy: false };
  function toggleLogView() {
    LOGVIEW.open = !LOGVIEW.open;
    const pre = $('#scLog');
    pre.hidden = !LOGVIEW.open;
    $('#scLogToggle').setAttribute('aria-expanded', String(LOGVIEW.open));
    $('#scLogToggle').textContent = LOGVIEW.open ? 'Hide boot log' : 'Show boot log';
    if (LOGVIEW.open) { pre.textContent = 'loading...'; refreshLog(true); startLogTimer(); } else stopLogTimer();
  }
  function startLogTimer() { stopLogTimer(); LOGVIEW.timer = setInterval(() => refreshLog(false), 3000); }
  function stopLogTimer() { clearInterval(LOGVIEW.timer); LOGVIEW.timer = null; }
  function stopLogView() {
    stopLogTimer();
    LOGVIEW.open = false;
    $('#scLog').hidden = true;
    $('#scLog').textContent = '';
    $('#scLogToggle').setAttribute('aria-expanded', 'false');
    $('#scLogToggle').textContent = 'Show boot log';
  }
  async function refreshLog(force) {
    const name = CURRENT;
    if (!name || !LOGVIEW.open || TAB !== 'serial' || LOGVIEW.busy) return;
    if (!force && document.hidden) return;
    const pre = $('#scLog');
    if (!force && selectionIn(pre)) return; // never wipe what the user is selecting
    LOGVIEW.busy = true;
    try {
      const j = await api('/api/log?name=' + encodeURIComponent(name) + '&tail=400');
      if (name !== CURRENT || !LOGVIEW.open) return;
      const text = j.text || '(empty)';
      if (pre.textContent !== text) {
        const atEnd = force || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        pre.textContent = text;
        if (atEnd) pre.scrollTop = pre.scrollHeight; // newest lines in view
      }
    } catch (e) {
      if (!e.auth && name === CURRENT) pre.textContent = 'Could not read the log: ' + e.message;
    } finally {
      LOGVIEW.busy = false;
    }
  }
  async function downloadLog(b) {
    const name = CURRENT;
    if (!name) return;
    const undo = busyButton(b);
    try {
      const j = await api('/api/log?name=' + encodeURIComponent(name) + '&tail=5000');
      const url = URL.createObjectURL(new Blob([j.text || ''], { type: 'text/plain;charset=utf-8' }));
      const a = h('a', { href: url, download: name + '-serial.log', hidden: true });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      if (j.truncated) toast('Saved the newest part of the log (the manager sends at most the last 256 KB).', 'ok');
    } catch (e) {
      toastError(e);
    } finally {
      undo();
    }
  }

  // ===========================================================================
  // presets + "Run a Docker image"
  // ===========================================================================
  // Starting points. The text fields (ports, volumes, env) fill the VM Docker
  // tab's deploy form, whose volumes are folders INSIDE that VM; `run` fills
  // the "Run a Docker image" form, with an engine per preset (microVM spec
  // 12.2). Home Assistant shows why the override fields exist: its image
  // declares neither EXPOSE nor VOLUME, and it needs privileged mode and the
  // host network, which only Docker inside a VM gives. The time zone of this
  // PC is passed to Docker-in-VM containers automatically, so no preset sets TZ.
  const PRESETS = [
    { key: 'homeassistant', label: 'Home Assistant', image: 'ghcr.io/home-assistant/home-assistant:stable', container: 'homeassistant',
      ports: '8123:8123', volumes: '/opt/homeassistant/config:/config', privileged: true, hostNetwork: true,
      note: 'This image declares no ports and no volumes, so the Ports and Volumes fields do the work. The first start takes a few minutes.',
      run: { engine: 'docker-vm', privileged: true, hostNetwork: true, ports: [[8123, 8123]], volumes: [['/opt/homeassistant/config', '/config']],
        note: 'Home Assistant needs privileged mode and the host network, so it runs with Docker inside a VM - a few minutes the first time.' } },
    { key: 'nginx', label: 'nginx (web server)', image: 'nginx:alpine', container: 'nginx', ports: '8080:80',
      note: 'The image declares port 80; the Ports field only chooses the port on this PC.',
      run: { engine: 'microvm', ports: [[8080, 80]],
        note: 'Serves its welcome page on port 8080 of this PC. To serve your own files, add a folder on this PC under Volumes and folders with the path /usr/share/nginx/html.' } },
    { key: 'gitea', label: 'Gitea (self-hosted Git)', image: 'gitea/gitea:latest', container: 'gitea', ports: '3000:3000', volumes: '/opt/gitea:/data',
      run: { engine: 'microvm', ports: [[3000, 3000]], volumes: [['gitea-data', '/data']],
        note: 'The repositories live in the volume "gitea-data", so they survive removing the container.' } },
    { key: 'uptime-kuma', label: 'Uptime Kuma (service monitor)', image: 'louislam/uptime-kuma:1', container: 'uptime-kuma',
      ports: '3001:3001', volumes: '/opt/uptime-kuma:/app/data',
      run: { engine: 'auto', ports: [[3001, 3001]], volumes: [['uptime-kuma-data', '/app/data']],
        note: 'A larger Node.js app. It runs from its image disk, so the image size does not decide its memory; if it starts slowly, give it 256 MB under Options > Memory.' } },
    { key: 'redis', label: 'Redis', image: 'redis:7-alpine', container: 'redis', ports: '6379:6379',
      run: { engine: 'microvm', ports: [[6379, 6379]] } },
    { key: 'postgres', label: 'PostgreSQL', image: 'postgres:16-alpine', container: 'postgres', ports: '5432:5432',
      volumes: '/opt/postgres:/var/lib/postgresql/data', env: 'POSTGRES_PASSWORD=postgres',
      run: { engine: 'microvm', ports: [[5432, 5432]], env: [['POSTGRES_PASSWORD', 'postgres']], volumes: [['pgdata', '/var/lib/postgresql/data']],
        note: 'The database lives in the volume "pgdata", so it survives removing the container. Change the password before you rely on it.' } },
  ];
  function fillPresetSelect(sel) {
    setChildren(sel, h('option', { value: '' }, '- pick an app, or type an image below -'),
      PRESETS.map((p) => h('option', { value: p.key }, p.label)));
  }
  function onQuickPreset() {
    RUN.card = null; // the preset note replaces any earlier run result
    const p = PRESETS.find((x) => x.key === $('#qPreset').value);
    if (!p) { setChildren($('#qInfo')); return; }
    const r = p.run || {};
    $('#qImg').value = p.image;
    memHintSoon();
    $('#qName').value = '';
    $('#qCmd').value = '';
    $('#qEngine').value = r.engine || 'auto';
    $('#qPriv').checked = !!r.privileged;
    $('#qHostNet').checked = !!r.hostNetwork;
    // the root filesystem goes back to the default (disk) unless the preset
    // names one: an earlier RAM choice must not ride along hidden (cov-3)
    delete $('#qRootfs').dataset.touched;
    $('#qRootfs').value = r.rootfs === 'ram' || r.rootfs === 'disk' ? r.rootfs : mvDefaults().rootfs;
    onRootfsChange();
    RUN.ports.set((r.ports || []).map((x) => ({ host: x[0], guest: x[1], proto: 'tcp', lan: defaultLan() })));
    RUN.env.set((r.env || []).map((x) => ({ name: x[0], value: x[1] })));
    RUN.vols.set((r.volumes || []).map((x) => ({ src: x[0], target: x[1], ro: false, copy: false })));
    onRunEngineChange();
    // switches a preset turns on are shown, never set invisibly
    const extra = [r.privileged ? 'privileged' : null, r.hostNetwork ? 'host network' : null].filter(Boolean);
    $('#qMore').open = true;
    if (extra.length || r.engine === 'docker-vm' || $('#qRootfs').value !== 'disk') $('#qAdv').open = true;
    setChildren($('#qInfo'), [r.note || p.note, extra.length ? 'This preset turns on: ' + extra.join(', ') + '.' : null].filter(Boolean).join(' '));
  }

  // ---- row editors (ports, environment, volumes and folders) ----
  // Rows live in plain arrays: typing only updates the row object, so an
  // input is never rebuilt under the user's fingers (UI-8); add and remove
  // re-render the rows, keeping focus by data-fk (UI-11).
  const str = (v) => String(v === undefined || v === null ? '' : v).trim();
  function focusLastRow(box) {
    const inputs = $$('input:not([type=checkbox]),select', box);
    const firstOfLast = inputs.length ? inputs[inputs.length - (box.dataset.cols ? +box.dataset.cols : 1)] : null;
    if (firstOfLast) firstOfLast.focus();
  }
  function rowInput(value, attrs, onInput) {
    const el = h('input', Object.assign({ autocomplete: 'off', spellcheck: 'false' }, attrs));
    el.value = value === undefined || value === null ? '' : String(value);
    el.addEventListener('input', () => onInput(el.value));
    return el;
  }
  function rowCheck(checked, onChange) {
    const el = h('input', { type: 'checkbox', checked: !!checked });
    el.addEventListener('change', () => onChange(el.checked));
    return el;
  }

  // ports: [{host, guest, proto, lan}]
  function portEditor(box, o) {
    const ed = { rows: [] };
    box.dataset.cols = '3';
    ed.changed = () => { if (o.onChange) o.onChange(); };
    ed.render = () => {
      const kids = [h('div', { class: 'ph' }, 'Port on this PC'), h('div', { class: 'ph' }, 'Container port'), h('div', { class: 'ph' }, 'Protocol'),
        h('div', { class: 'ph' }, 'Exposure'), h('div', { class: 'ph' }, h('span', { class: 'sr-only' }, 'Remove'))];
      if (!ed.rows.length) kids.push(h('div', { class: 'none' }, o.empty));
      ed.rows.forEach((r, i) => {
        const n = i + 1;
        const proto = h('select', { 'aria-label': 'Protocol, port row ' + n, data: { fk: o.fk + 'p' + i } },
          h('option', { value: 'tcp' }, 'TCP'), h('option', { value: 'udp' }, 'UDP'));
        proto.value = r.proto === 'udp' ? 'udp' : 'tcp';
        proto.addEventListener('change', () => { r.proto = proto.value; ed.changed(); });
        kids.push(
          rowInput(r.host, { type: 'number', min: 1, max: 65535, inputmode: 'numeric', placeholder: 'same', 'aria-label': 'Port on this PC, port row ' + n, data: { fk: o.fk + 'h' + i } },
            (v) => { r.host = v; ed.changed(); }),
          rowInput(r.guest, { type: 'number', min: 1, max: 65535, inputmode: 'numeric', 'aria-label': 'Container port, port row ' + n, data: { fk: o.fk + 'g' + i } },
            (v) => { r.guest = v; ed.changed(); }),
          proto,
          h('label', { class: 'chk', title: 'Other devices on your network can connect (Windows Firewall may ask once)' },
            rowCheck(r.lan, (v) => { r.lan = v; ed.changed(); }), 'LAN'),
          btn('Remove', 'sm danger-outline', { aria: 'Remove port row ' + n, fk: o.fk + 'x' + i, onClick: () => { ed.rows.splice(i, 1); ed.changed(); ed.render(); } }));
      });
      keepFocusIn(box, () => setChildren(box, kids));
    };
    ed.set = (list) => { ed.rows = list.map((p) => ({ host: p.host, guest: p.guest, proto: p.proto === 'udp' ? 'udp' : 'tcp', lan: !!p.lan })); ed.render(); };
    ed.add = () => { ed.rows.push({ host: '', guest: '', proto: 'tcp', lan: defaultLan() }); ed.changed(); ed.render(); focusLastRow(box); };
    // -> {ports} or {error}; a blank host port means "the same number"
    ed.read = () => {
      const out = [], seen = new Set();
      for (let i = 0; i < ed.rows.length; i++) {
        const r = ed.rows[i], n = i + 1;
        const hraw = str(r.host), graw = str(r.guest);
        if (!hraw && !graw) continue; // an empty row is ignored
        const guest = toInt(graw || hraw), host = hraw ? toInt(hraw) : guest;
        if (!isPort(guest)) return { error: 'Port row ' + n + ': the container port must be a number from 1 to 65535.' };
        if (!isPort(host)) return { error: 'Port row ' + n + ': the port on this PC must be a number from 1 to 65535.' };
        const proto = r.proto === 'udp' ? 'udp' : 'tcp';
        if (seen.has(proto + host)) return { error: 'Port ' + host + (proto === 'udp' ? '/udp' : '') + ' on this PC is used by two rows.' };
        seen.add(proto + host);
        out.push({ host: host, guest: guest, proto: proto, lan: !!r.lan });
      }
      return { ports: out };
    };
    return ed;
  }

  // environment: [{name, value}] -> ["NAME=value"]
  const RE_ENV = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
  function envEditor(box, o) {
    const ed = { rows: [] };
    box.dataset.cols = '2';
    ed.render = () => {
      const kids = [h('div', { class: 'ph' }, 'Name'), h('div', { class: 'ph' }, 'Value'), h('div', { class: 'ph' }, h('span', { class: 'sr-only' }, 'Remove'))];
      if (!ed.rows.length) kids.push(h('div', { class: 'none' }, o.empty));
      ed.rows.forEach((r, i) => {
        const n = i + 1;
        kids.push(
          rowInput(r.name, { placeholder: 'APP_ENV', 'aria-label': 'Variable name, row ' + n, data: { fk: o.fk + 'n' + i } }, (v) => { r.name = v; }),
          rowInput(r.value, { placeholder: 'value', 'aria-label': 'Value, row ' + n, data: { fk: o.fk + 'v' + i } }, (v) => { r.value = v; }),
          btn('Remove', 'sm danger-outline', { aria: 'Remove variable row ' + n, fk: o.fk + 'x' + i, onClick: () => { ed.rows.splice(i, 1); ed.render(); } }));
      });
      keepFocusIn(box, () => setChildren(box, kids));
    };
    ed.set = (list) => { ed.rows = list.map((e) => ({ name: e.name, value: e.value })); ed.render(); };
    ed.add = () => { ed.rows.push({ name: '', value: '' }); ed.render(); focusLastRow(box); };
    ed.read = () => {
      const out = [], seen = new Set();
      for (let i = 0; i < ed.rows.length; i++) {
        const r = ed.rows[i], name = str(r.name);
        const value = r.value === undefined || r.value === null ? '' : String(r.value);
        if (!name && !value) continue;
        if (!RE_ENV.test(name)) return { error: 'Environment row ' + (i + 1) + ': a name uses letters, digits and "_", and does not start with a digit.' };
        if (seen.has(name)) return { error: 'The variable ' + name + ' is set twice.' };
        if (value.indexOf('\0') !== -1) return { error: 'The value of ' + name + ' contains a NUL character.' };
        seen.add(name);
        out.push(name + '=' + value);
      }
      return { env: out };
    };
    return ed;
  }

  // volumes and folders: [{src, target, ro, copy}]. src is a named volume
  // (kept by the manager) or a folder on this PC - a LIVE shared folder, or
  // copied in once at start when "Copy in" is ticked. mode 'vm' (Docker
  // inside a VM): src is a folder inside that VM or a Docker volume name.
  function volKind(src, mode) {
    const s = str(src);
    if (!s) return '';
    if (mode === 'vm') return s.charAt(0) === '/' ? 'a folder inside the VM' : (isHostPath(s) ? 'a folder on this PC cannot be used by a Docker VM' : 'a Docker volume in the VM');
    return isHostPath(s) ? 'a folder on this PC' : 'a named volume';
  }
  function volEditor(box, o) {
    const ed = { rows: [], mode: 'microvm' };
    box.dataset.cols = '2';
    ed.render = () => {
      const vm = ed.mode === 'vm';
      const kids = [h('div', { class: 'ph' }, vm ? 'Folder in the VM or volume name' : 'Volume name or folder on this PC'),
        h('div', { class: 'ph' }, h('span', { class: 'sr-only' }, 'Browse')),
        h('div', { class: 'ph' }, 'Path in the container'), h('div', { class: 'ph' }, 'Read-only'),
        h('div', { class: 'ph' }, vm ? '' : 'Copy in'), h('div', { class: 'ph' }, h('span', { class: 'sr-only' }, 'Remove'))];
      if (!ed.rows.length) kids.push(h('div', { class: 'none' }, vm ? o.emptyVm : o.empty));
      ed.rows.forEach((r, i) => {
        const n = i + 1;
        const kind = h('div', { class: 'kind' });
        const copy = h('input', { type: 'checkbox', checked: !!r.copy, title: 'Copy the folder into the container once, at start (one-way)' });
        const sync = () => {
          const host = !vm && isHostPath(str(r.src));
          copy.disabled = !host;
          if (!host && copy.checked) { copy.checked = false; r.copy = false; }
          let t = volKind(r.src, ed.mode);
          if (host) t += r.copy ? ' - copied over the container\'s files at every start (nothing is written back; a file deleted here is not deleted there)' : ' - shared live, both ways';
          setText(kind, t ? 'Row ' + n + ': ' + t : '');
        };
        copy.addEventListener('change', () => { r.copy = copy.checked; sync(); });
        const src = rowInput(r.src, { placeholder: vm ? '/opt/app/data' : 'pgdata  or  C:\\Users\\me\\site', 'aria-label': (vm ? 'Folder in the VM or volume name' : 'Volume name or folder on this PC') + ', row ' + n, data: { fk: o.fk + 's' + i } },
          (v) => { r.src = v; sync(); });
        const browse = vm ? h('span') : btn('Browse...', 'sm', { aria: 'Choose a folder on this PC for row ' + n, fk: o.fk + 'b' + i, onClick: (b) => browseInto(src, b) });
        kids.push(src, browse,
          rowInput(r.target, { placeholder: '/data', 'aria-label': 'Path in the container, row ' + n, data: { fk: o.fk + 't' + i } }, (v) => { r.target = v; }),
          h('label', { class: 'chk' }, rowCheck(r.ro, (v) => { r.ro = v; }), h('span', { class: 'sr-only' }, 'Read-only, row ' + n), 'ro'),
          vm ? h('span') : h('label', { class: 'chk' }, copy, h('span', { class: 'sr-only' }, 'Copy in at start, row ' + n), 'copy'),
          btn('Remove', 'sm danger-outline', { aria: 'Remove volume row ' + n, fk: o.fk + 'x' + i, onClick: () => { ed.rows.splice(i, 1); ed.render(); } }),
          kind);
        sync();
      });
      keepFocusIn(box, () => setChildren(box, kids));
    };
    ed.set = (list) => { ed.rows = list.map((v) => ({ src: v.src, target: v.target, ro: !!v.ro, copy: !!v.copy })); ed.render(); };
    ed.add = () => { ed.rows.push({ src: '', target: '', ro: false, copy: false }); ed.render(); const s = $$('input[data-fk^="' + o.fk + 's"]', box); if (s.length) s[s.length - 1].focus(); };
    // mode 'microvm' -> {volumes: ["name:/t[:ro]" | "C:\dir:/t[:ro]"], copyIn: ["C:\dir:/t"]}
    // mode 'vm'      -> {volumes: ["/vm/dir:/t[:ro]" | "name:/t[:ro]"]}
    ed.read = (mode) => {
      const volumes = [], copyIn = [], targets = new Set();
      for (let i = 0; i < ed.rows.length; i++) {
        const r = ed.rows[i], n = i + 1;
        const src = str(r.src), target = str(r.target).replace(/\/+$/, '');
        if (!src && !target) continue;
        if (!src) return { error: 'Volume row ' + n + ': enter a volume name or choose a folder' + (mode === 'vm' ? ' inside the VM.' : ' on this PC (Browse...).') };
        if (!/^\/[^\0\n\r:]*$/.test(target) || target === '') return { error: 'Volume row ' + n + ': the path in the container must be absolute, e.g. /data.' };
        if (targets.has(target)) return { error: 'Two volume rows use the container path ' + target + '.' };
        targets.add(target);
        const ro = r.ro ? ':ro' : '';
        if (mode === 'vm') {
          if (isHostPath(src) && src.charAt(0) !== '/') return { error: 'Volume row ' + n + ': ' + src + ' is a folder on this PC - a Docker VM cannot use it. Use a folder inside the VM (e.g. /opt/app/data), or run with a microVM to share it live.' };
          if (src.charAt(0) !== '/' && !RE_VOLUME.test(src)) return { error: 'Volume row ' + n + ': use a folder inside the VM (e.g. /opt/app/data) or a volume name.' };
          volumes.push(src + ':' + target + ro);
        } else if (isHostPath(src)) {
          if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(src)) return { error: 'Volume row ' + n + ': use the full path of the folder on this PC, e.g. C:\\Users\\me\\site (Browse... fills it in).' };
          if (r.copy) copyIn.push(src + ':' + target); else volumes.push(src + ':' + target + ro);
        } else {
          if (!RE_VOLUME.test(src)) return { error: 'Volume row ' + n + ': a volume name uses letters, digits, ".", "_" or "-" (or choose a folder on this PC with Browse...).' };
          volumes.push(src + ':' + target + ro);
        }
      }
      return { volumes: volumes, copyIn: copyIn };
    };
    return ed;
  }

  // ---- folder picker: GET /api/fs/dirs inside the in-app modal ----
  // Only folder names come back (never file contents); the server starts at
  // the user profile and lists the drive roots on Windows.
  function joinPath(base, name) {
    const sep = /\\/.test(base) || /^[A-Za-z]:/.test(base) ? '\\' : '/';
    return String(base).replace(/[\\/]+$/, '') + sep + name;
  }
  async function pickFolder(start) {
    const pathIn = h('input', { id: 'fpPath', name: 'path', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'fpStatus' });
    pathIn.value = start || '';
    const status = h('div', { class: 'small', id: 'fpStatus', role: 'status' });
    const roots = h('div', { class: 'btns mt' });
    const list = h('div', { class: 'folder-list', role: 'group', 'aria-label': 'Folders' });
    const up = btn('Up one level', 'sm', { disabled: true });
    let seq = 0, parent = null;
    const go = async (p) => {
      const my = ++seq;
      setText(status, 'Loading...');
      let j;
      try {
        j = await api('/api/fs/dirs' + (p ? '?path=' + encodeURIComponent(p) : ''));
      } catch (e) {
        if (my !== seq || e.auth) return;
        setText(status, notImpl(e) ? 'Browsing is not available in this version of the manager - type the full path of the folder above.'
          : 'Could not open that folder: ' + e.message);
        return;
      }
      if (my !== seq || !MODAL) return;
      const cur = typeof j.path === 'string' ? j.path : (p || '');
      pathIn.value = cur;
      parent = typeof j.parent === 'string' && j.parent ? j.parent : null;
      up.disabled = !parent;
      const rs = (Array.isArray(j.roots) ? j.roots : []).map((r) => (typeof r === 'string' ? r : (r && (r.path || r.name)) || '')).filter(Boolean);
      const home = typeof j.home === 'string' && j.home ? j.home : null;
      setChildren(roots, home ? btn('Home', 'sm', { aria: 'Go to your user folder', onClick: () => go(home) }) : null,
        rs.map((r) => btn(r, 'sm', { aria: 'Go to ' + r, onClick: () => go(r) })));
      const dirs = (Array.isArray(j.dirs) ? j.dirs : []).filter((d) => d && typeof d.name === 'string');
      // refused: the data folder, system folders and what contains them -
      // shown, so the list is not confusing, but not openable
      setChildren(list, dirs.length ? dirs.map((d) => h('button', {
        type: 'button', disabled: d.readable === false || !!d.refused,
        title: d.refused ? String(d.refused) : (d.readable === false ? 'Not readable' : null),
        onclick: () => go(typeof d.path === 'string' ? d.path : joinPath(cur, d.name)),
      }, d.name + (d.link ? '  (link)' : ''))) : h('div', { class: 'none' }, j.readable === false ? 'This folder cannot be opened.' : 'No folders inside this one.'));
      setText(status, j.readable === false && j.error ? String(j.error)
        : (cur ? dirs.length + ' folder' + (dirs.length === 1 ? '' : 's') + (j.truncated ? ' (only the first ones are shown)' : '') : ''));
    };
    up.addEventListener('click', () => { if (parent) go(parent); });
    pathIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(pathIn.value.trim()); } });
    const r = await openModal({
      title: 'Choose a folder on this PC', wide: true,
      hint: 'Open folders by clicking them, or type a path and press Enter. The manager\'s own data folder and system folders cannot be shared.',
      content: [field('fpPath', 'Folder', pathIn), h('div', { class: 'btns mt' }, up), roots, list, status],
      submitLabel: 'Use this folder', initialFocus: pathIn,
      onOpen: () => go(str(start)),
      onSubmit: (d, m) => {
        const p = str(d.path);
        if (!p) { m.error('Choose a folder, or type its full path.'); return false; }
        return { path: p };
      },
    });
    return r && r.path ? r.path : null;
  }

  // ---- the Run form ----
  // card: the running container the result under the Run form is about
  const RUN = { ports: null, env: null, vols: null, seq: 0, card: null };
  // The engine the form will use: privileged / host network need a full
  // Docker, which only the Docker-in-VM engine has.
  function runEngine() {
    const sel = $('#qEngine').value || 'auto';
    const forced = $('#qPriv').checked || $('#qHostNet').checked;
    return { sel: sel, forced: forced, effective: forced ? 'docker-vm' : sel };
  }
  function onRunEngineChange() {
    const e = runEngine();
    const vm = e.effective === 'docker-vm';
    $('#qVmOpts').hidden = !vm;
    // a full VM with Docker has its own disk: the root filesystem choice is microVM-only
    $('#qMvOpts').hidden = vm;
    if (RUN.vols.mode !== (vm ? 'vm' : 'microvm')) { RUN.vols.mode = vm ? 'vm' : 'microvm'; RUN.vols.render(); }
    setText($('#qVolHint'), vm
      ? 'Each row is a folder inside the VM (e.g. /opt/app/data, created for you) or a Docker volume name. To use a folder on this PC, run the image with a microVM, or add it to the VM\'s Shared folders later.'
      : 'Each row is a named volume (storage the manager keeps, e.g. pgdata) or a folder on this PC (Browse...). A folder is shared live, both ways, while the container runs; tick "copy" to copy it in at every start instead (quicker for huge folders; it is copied over the container\'s files, nothing is written back, and a file you delete here stays in the container until it is removed or started fresh).');
    setText($('#qVolCaveat'), vm ? '' : 'Folders on this PC: ' + SHARE_CAVEAT + ' ' + SHARE_ACCESS);
    setText($('#qGo'), vm ? 'Create VM and deploy' : 'Run');
    renderRunEngine();
  }
  // Root filesystem of the run form: the why, the memory floor and the
  // memory placeholder follow the choice
  function onRootfsChange() {
    setText($('#qRootfsHint'), ROOTFS_WHY[$('#qRootfs').value === 'ram' ? 'ram' : 'disk']);
    setText($('#qMemHint'), memWhy($('#qRootfs').value));
    syncMemMin();
    memHintSoon();
  }
  // The result under the Run form describes a container at one moment. Once
  // that container stops or is removed from somewhere else (its row, Manage,
  // Claude via MCP), say so instead of offering Stop for something gone.
  function renderRunCard() {
    const card = RUN.card;
    if (!card) return;
    if (card.seq !== RUN.seq) { RUN.card = null; return; } // a newer run owns the area
    const c = CTRS.get(card.id);
    if (c && ctrLive(c)) return;
    RUN.card = null;
    const info = $('#qInfo');
    if (!c) { setChildren(info, h('div', null, '"' + card.name + '" has been removed.')); return; }
    const code = Number.isInteger(c.exitCode) ? ' (exit code ' + c.exitCode + ')' : '';
    setChildren(info, h('div', null, card.image + ' ("' + card.name + '") is no longer running' + code + '.'),
      h('div', { class: 'btns mt' },
        btn('Logs', 'sm', { onClick: () => selectCtr(card.id, 'logs') }),
        btn('Manage container', 'sm', { onClick: () => selectCtr(card.id) })));
  }

  function renderRunEngine() {
    if (!RUN.vols) return;
    const e = runEngine();
    const mv = (STATE && STATE.microvm) || null;
    const baseOk = !!(STATE && STATE.prereqs && STATE.prereqs.base && STATE.prereqs.base.ok);
    let note = '';
    if (e.forced && e.sel === 'microvm') note = 'privileged and host network need Docker inside a VM - choose Automatic or Docker inside a VM under Advanced.';
    else if (e.effective === 'docker-vm') note = (e.forced ? 'privileged / host network: runs with Docker inside a VM.' : 'Engine: Docker inside a VM.')
      + (STATE && !baseOk ? ' It needs the base image first (Setup above).' : '');
    else if (mv && mv.ready === false) note = 'Docker images need the one-minute setup first: "Set up for Docker images" above.';
    else if (e.sel === 'microvm') note = 'Engine: microVM only.';
    setText($('#qEngineNote'), note);
    setText($('#qEngineHint'), 'Automatic runs the image as a microVM - its own small VM that starts in seconds and uses little memory - and '
      + 'only picks Docker inside a VM when the request or the image needs a full Docker (and says why). Docker inside a VM creates a whole VM '
      + '(about 2 GB of RAM, several minutes the first time) and is the engine for compose stacks, privileged images and the host network.'
      + (mv && mv.accel === 'tcg' ? ' This PC has no hardware acceleration: microVMs use TCG software emulation (slower, and not a security boundary).' : ''));
  }

  // Everything the form holds, checked. -> {error, focus, adv} or the values
  function readRunForm() {
    const e = runEngine();
    const L = limits();
    const out = { engine: e.effective, privileged: $('#qPriv').checked, hostNetwork: $('#qHostNet').checked };
    if (e.forced && e.sel === 'microvm') return { error: 'privileged and host network need Docker inside a VM: choose Automatic or "Docker inside a VM" as the engine, or untick them.', adv: true, focus: $('#qEngine') };
    const vm = e.effective === 'docker-vm';
    out.name = $('#qName').value.trim();
    if (out.name && !(vm ? RE.container : RE.vm).test(out.name)) return { error: 'Container name: use letters, digits, ".", "_" or "-", starting with a letter or digit.', focus: $('#qName') };
    const memRaw = $('#qMem').value.trim(), cpuRaw = $('#qCpu').value.trim();
    out.mem = memRaw ? toInt(memRaw) : undefined;
    out.cpus = cpuRaw ? toInt(cpuRaw) : undefined;
    // microVM only; sent as chosen, so the run does not depend on when the
    // global default changes
    if (!vm) out.rootfs = $('#qRootfs').value === 'ram' ? 'ram' : 'disk';
    const minMem = vm ? L.minMem : minMemFor(out.rootfs);
    if (out.mem !== undefined && (out.mem === null || out.mem < minMem || out.mem > L.maxMem)) {
      return { error: 'Memory must be a number from ' + minMem + ' to ' + L.maxMem + ' MB' + (vm ? '' : (out.rootfs === 'ram' ? ' for a RAM root' : ' for a disk root')) + ', or blank for automatic.', focus: $('#qMem') };
    }
    if (out.cpus !== undefined && (out.cpus === null || out.cpus < 1 || out.cpus > L.maxCpus)) return { error: 'vCPUs must be a number from 1 to ' + L.maxCpus + ', or blank.', focus: $('#qCpu') };
    const p = RUN.ports.read();
    if (p.error) return { error: p.error };
    out.ports = p.ports;
    const en = RUN.env.read();
    if (en.error) return { error: en.error };
    out.env = en.env;
    const v = RUN.vols.read(vm ? 'vm' : 'microvm');
    if (v.error) return { error: v.error };
    out.volumes = v.volumes;
    out.copyIn = v.copyIn;
    // the same rows for Docker-in-VM, should the manager suggest it later
    out.vmVols = RUN.vols.read('vm');
    const cmd = $('#qCmd').value.trim();
    if (cmd) {
      const argv = splitArgs(cmd);
      if (!argv) return { error: 'Command: a quote is not closed.', focus: $('#qCmd') };
      out.cmd = argv;
    }
    if (vm && out.cmd) return { error: 'A command can only be given for microVMs here; Docker inside a VM runs the image\'s own command.', focus: $('#qCmd') };
    out.vmName = $('#qVmName').value.trim();
    if (vm && out.vmName && vmNameProblem(out.vmName)) return { error: 'VM name: ' + vmNameProblem(out.vmName), adv: true, focus: $('#qVmName') };
    out.keep = $('#qKeep').checked;
    out.autoRemove = $('#qRm').checked;
    out.autostart = $('#qAuto').checked;
    if (out.autoRemove && out.autostart) return { error: '"Remove the container when it exits" and "Start it with the manager" cannot both be on.', focus: $('#qRm') };
    out.ephemeral = $('#qTemp').checked;
    out.lan = $('#qLan').checked;
    return out;
  }

  async function runImage(b) {
    const err = $('#qErr'), info = $('#qInfo');
    const image = $('#qImg').value.trim();
    const why = imageProblem(image);
    if (why) return showErr(err, why, $('#qImg'));
    const f = readRunForm();
    if (f.error) {
      $('#qMore').open = true;
      if (f.adv) $('#qAdv').open = true;
      return showErr(err, f.error, f.focus || null);
    }
    hideErr(err);
    if (f.engine === 'docker-vm') return runInDockerVm(b, image, f);
    const body = {
      image: image, engine: f.engine, lan: f.lan, createdBy: 'gui',
      autoRemove: f.autoRemove, autostart: f.autostart, ephemeral: f.ephemeral,
    };
    if (f.name) body.name = f.name;
    if (f.mem !== undefined) body.mem = f.mem;
    if (f.cpus !== undefined) body.cpus = f.cpus;
    if (f.rootfs) body.rootfs = f.rootfs;
    // no rows: the manager publishes the ports the image declares
    if (f.ports.length) body.ports = f.ports;
    if (f.env.length) body.env = f.env;
    if (f.volumes.length) body.volumes = f.volumes;
    if (f.copyIn.length) body.copyIn = f.copyIn;
    if (f.cmd) body.cmd = f.cmd;
    const seq = ++RUN.seq;
    let engine = 'microvm';
    const t = await runTask('/api/container/run', body, {
      btn: b,
      onError: (e) => runRefused(e, image, f),
      onAccepted: (task, reply) => {
        engine = reply && reply.engine === 'docker-vm' ? 'docker-vm' : 'microvm';
        setChildren(info, engine === 'docker-vm'
          ? 'Automatic chose Docker inside a VM' + (reply.reason ? ': ' + reply.reason : '') + '. This takes a few minutes - progress is shown under Tasks.'
          : 'Starting ' + image + ' as a microVM - progress is shown under Tasks.');
      },
    });
    if (!t || seq !== RUN.seq) return; // refused, or a newer run owns the result area
    if (engine === 'docker-vm' || t.kind === 'quickdeploy') showVmDeployResult(info, image, t);
    else showRunResult(info, image, t, f);
  }

  // The manager refused the run before starting anything.
  function runRefused(e, image, f) {
    const err = $('#qErr'), info = $('#qInfo');
    const body = e.body || {};
    if (notImpl(e)) {
      showErr(err, 'Running images as microVMs is not available in this version of the manager yet.');
      setChildren(info, h('div', { class: 'btns' }, btn('Run with Docker inside a VM instead', 'sm', { onClick: (b) => offerFallback({ image: image, form: f, btn: b }) })));
      return;
    }
    showErr(err, e.message);
    if (e.code === 'NO_KERNEL' || body.action === 'install-kernel') {
      setChildren(info, h('div', { class: 'btns' }, btn('Set up for Docker images (about 1 minute)', 'sm primary', {
        onClick: (b) => runTask('/api/setup', { only: 'microvm' }, { btn: b }),
      })));
    } else if (body.fallback || e.code === 'NOT_COMPATIBLE' || e.code === 'ZSTD_UNSUPPORTED' || e.code === 'HOST_FOLDER') {
      setChildren(info, fallbackBox((body.fallback && body.fallback.reason) || body.hint || null,
        (b) => offerFallback({ image: image, form: f, reason: (body.fallback && body.fallback.reason) || e.message, btn: b })));
    } else if (body.hint) {
      setChildren(info, h('div', { class: 'small' }, body.hint));
    } else setChildren(info);
  }

  // Docker inside a VM: the proven quick-deploy route (a new VM with Docker).
  // f: the checked form; volumes as folders inside the VM.
  async function runInDockerVm(b, image, f) {
    const info = $('#qInfo'), err = $('#qErr');
    const vols = f.vmVols || { volumes: [] };
    if (vols.error) { showErr(err, vols.error); return null; }
    const body = {
      image: image, mem: f.mem, cpus: f.cpus,
      // per-row exposure, explicit, so the global default never overrides it
      ports: (f.ports || []).map((p) => (p.lan ? 'lan:' : 'local:') + p.host + ':' + p.guest + (p.proto === 'udp' ? '/udp' : '')),
      volumes: vols.volumes, env: f.env || [],
      lan: !!f.lan, privileged: !!f.privileged, hostNetwork: !!f.hostNetwork,
      ephemeral: !!f.ephemeral, keepOnFailure: !!f.keep, createdBy: 'gui',
    };
    if (f.vmName) body.name = f.vmName;
    if (f.name && RE.container.test(f.name)) body.containerName = f.name;
    const seq = ++RUN.seq;
    const t = await runTask('/api/vm/quickdeploy', body, {
      btn: b,
      onError: (e) => showErr(err, e.message), // the form keeps everything (UI-22)
      onAccepted: (task) => { hideErr(err); setChildren(info, (task.title || 'Deploying ' + image) + ' - this takes a few minutes; progress is shown under Tasks.'); },
    });
    if (!t || seq !== RUN.seq) return t;
    showVmDeployResult(info, image, t);
    return t;
  }
  function showVmDeployResult(info, image, t) {
    if (t.status === 'done') {
      showDeployed(info, image + ' is running' + (t.result && t.result.sandbox ? ' in the VM "' + t.result.sandbox + '"' : '') + '.', t);
      const vmName = t.result && t.result.sandbox;
      if (vmName && RE.vm.test(vmName)) info.appendChild(h('div', { class: 'mt' }, btn('Manage ' + vmName, 'sm', { onClick: () => selectVm(vmName) })));
    } else {
      setChildren(info, h('span', { class: 'field-error' }, 'The deploy failed: ' + firstLine(t.error)));
    }
  }

  // A finished microVM run: URLs, or the exit code and the output tail.
  async function showRunResult(info, image, t, f) {
    const res = t.result && typeof t.result === 'object' ? t.result : {};
    const id = ctrIdOfTask(t);
    const c = id ? CTRS.get(id) : null;
    const rc = res.container && typeof res.container === 'object' ? res.container : {};
    const cname = typeof rc.name === 'string' ? rc.name : (typeof res.name === 'string' ? res.name : (c ? c.name : null));
    // a container that runs gets Stop right here (spec 12.2)
    const running = t.status === 'done' && !Number.isInteger(res.exitCode) && !res.stopped;
    const buttons = id ? h('div', { class: 'btns mt' },
      btn('Logs', 'sm', { onClick: () => selectCtr(id, 'logs') }),
      running ? btn('Stop', 'sm', { onClick: (b) => stopCtr(b, { id: id, name: cname }) }) : null,
      btn('Manage container', 'sm', { onClick: () => selectCtr(id) })) : null;
    if (t.status === 'done') {
      const kids = [];
      const exited = Number.isInteger(res.exitCode);
      kids.push(h('div', null, res.stopped ? image + ' was stopped before the app started.'
        : (exited ? image + ' ran and exited with code ' + res.exitCode + (EXIT_MEANING[res.exitCode] ? ' (' + EXIT_MEANING[res.exitCode] + ')' : '') + '.'
          : image + ' is running' + (cname ? ' as "' + cname + '"' : '') + '.')));
      if (res.exitReason && exited && res.exitCode !== 0) kids.push(h('div', { class: 'small' }, String(res.exitReason).slice(0, 300)));
      const links = urlLinks(res.urls);
      if (links.length) kids.push(h('div', { class: 'urls' }, 'Open: ', links));
      else if (!exited) kids.push(h('div', null, 'No web port is published - add one under Options > Ports if the app has a web page.'));
      for (const k of ['stdout', 'stderr']) {
        if (typeof res[k] === 'string' && res[k]) kids.push(h('pre', { tabindex: '0', 'aria-label': k === 'stdout' ? 'Output' : 'Errors' }, res[k]));
      }
      for (const w of Array.isArray(res.warnings) ? res.warnings : []) kids.push(h('div', { class: 'small' }, 'Note: ' + errText(w)));
      kids.push(buttons);
      // an app that died at once may need a full Docker (microVM spec 14.4)
      if (res.fallback) kids.push(fallbackBox(errText(res.fallback.reason), (b) => offerFallback({ id: id, name: cname, image: image, form: f, reason: errText(res.fallback.reason), btn: b }), res.fallback, id));
      setChildren(info, kids);
      RUN.card = running && id ? { id: id, name: cname || id, image: image, seq: RUN.seq } : null;
      return;
    }
    setChildren(info, h('span', { class: 'field-error' }, 'The run failed: ' + firstLine(t.error)), buttons);
    // the engine may suggest Docker-in-VM for this image (microVM spec 14)
    let fb = res.fallback || (c && c.fallback) || null;
    if (!fb && id) {
      try {
        const j = await api('/api/container?id=' + encodeURIComponent(id));
        const rec = j.container && typeof j.container === 'object' ? j.container : j;
        fb = rec.fallback || null;
      } catch (e) { /* the error above is what matters */ }
    }
    if (fb && info.isConnected) {
      info.appendChild(fallbackBox(fb.reason, (b) => offerFallback({ id: id, name: cname, image: image, form: f, reason: fb.reason, btn: b }), fb, id));
    }
  }

  // ---- "Run with Docker-in-VM instead" (microVM spec 12.3, 14) ----
  // fb (optional): the engine's suggestion; a container that ran out of
  // memory first gets the cheaper offer, the same microVM with more memory
  // (spec 14.4: "Run with N MB"), when its id is known
  function fallbackBox(reason, onClick, fb, id) {
    const mem = fb && fb.code === 'NEEDS_MEMORY' && Number.isInteger(fb.memMB) && id ? fb.memMB : null;
    return h('div', { class: 'fallback' },
      h('div', { class: 'ftxt' }, h('b', null, mem ? 'This image ran out of memory. ' : 'This image may run better with Docker inside a VM. '), reason || ''),
      mem ? btn('Run with ' + mem + ' MB', 'sm primary', { onClick: (b) => runWithMemory(b, id, mem) }) : null,
      btn('Run with Docker-in-VM instead', mem ? 'sm' : 'sm primary', { onClick: onClick }));
  }
  async function runWithMemory(b, id, mem) {
    const undo = busyButton(b);
    try { await api('/api/container/settings', { body: { id: id, mem: mem } }); }
    catch (e) { if (!e.auth) toast('Could not set the memory: ' + e.message, 'err'); return null; }
    finally { undo(); }
    return runTask('/api/container/start', { id: id }, { btn: b });
  }
  // o: {id (existing container) | image + form, name, reason, btn}
  async function offerFallback(o) {
    const keep = h('input', { type: 'checkbox', name: 'keep' });
    // what does NOT move (correct-17): the data of the container's volumes
    // stays in its microVM volumes; shared and copied-in folders of this PC
    // are microVM-only
    const rec = o.id && CTRD.id === o.id && CTRD.rec ? CTRD.rec : null;
    const notMoved = [];
    if (rec) {
      for (const s of Array.isArray(rec.shares) ? rec.shares : []) notMoved.push('shared folder ' + errText(s.hostPath) + ' → ' + errText(s.guestPath));
      for (const c of Array.isArray(rec.copyIn) ? rec.copyIn : []) notMoved.push('copy-in ' + errText(c.hostDir) + ' → ' + errText(c.target));
    }
    const r = await openModal({
      title: 'Run ' + (o.name ? '"' + o.name + '"' : o.image) + ' with Docker-in-VM instead?',
      hint: (o.reason ? o.reason + '\n\n' : '') + 'This creates a full VM with Docker inside it: about 2 GB of RAM, and several minutes for the first start '
        + '(it needs the base image from Setup). ' + (o.id ? 'The container\'s image, ports (with the same exposure) and environment are carried over. '
        + 'Its named volumes become NEW, EMPTY Docker volumes in that VM - the data in the microVM volumes is not copied (it stays under Volumes). '
        + 'Folders shared from this PC and copy-in folders are not carried over.'
        + (notMoved.length ? '\n\nNot carried over: ' + notMoved.join('; ') + '.' : '') : 'The image, ports and environment from the form are used.'),
      content: h('label', { class: 'chk' }, keep, ' Keep the VM if the deploy fails (to look into it)'),
      submitLabel: 'Run with Docker-in-VM',
    });
    if (!r) return null;
    if (o.id) {
      const info = $('#qInfo');
      return runTask('/api/container/fallback', { id: o.id, keepOnFailure: !!r.keep }, {
        btn: o.btn, onAccepted: (task) => setChildren(info, (task.title || 'Deploying with Docker inside a VM') + ' - this takes a few minutes; progress is shown under Tasks.'),
      });
    }
    return runInDockerVm(o.btn, o.image, Object.assign({}, o.form, { keep: !!r.keep }));
  }
  function onDeployPreset() {
    const p = PRESETS.find((x) => x.key === $('#dpPreset').value);
    if (!p) { setChildren($('#dpInfo')); return; }
    $('#dpImg').value = p.image;
    $('#dpCName').value = p.container || '';
    $('#dpPorts').value = p.ports || '';
    $('#dpVols').value = p.volumes || '';
    $('#dpEnv').value = p.env || '';
    $('#dpPriv').checked = !!p.privileged;
    $('#dpHostNet').checked = !!p.hostNetwork;
    setChildren($('#dpInfo'), (p.note ? p.note + ' ' : '') + 'Press Deploy when ready.');
  }

  // ===========================================================================
  // Containers (microVM engine) - the table rides on /api/state; rows are
  // kept and updated in place like the VM rows
  // ===========================================================================
  const CTR_STATUS = { created: 'created', preparing: 'preparing', booting: 'starting', running: 'running', stopping: 'stopping', exited: 'exited', error: 'failed' };
  // live = has (or is about to have) a QEMU: Stop applies, Start does not
  const ctrLive = (c) => !!c && /^(preparing|booting|running|stopping)$/.test(c.status || '');
  const errText = (x) => (typeof x === 'string' ? x : (x && typeof x === 'object' && typeof x.message === 'string' ? x.message : ''));
  // a stop of this container is already on its way (the stop lock is not
  // the run lock, so `busy` may name the run task instead)
  function ctrStopping(id) {
    for (const t of TASKS.byId.values()) if (t.status === 'running' && t.kind === 'ctr-stop' && t.ctr === id) return true;
    return false;
  }
  function ctrPill(c) {
    const st = c.status || 'created';
    const code = Number.isInteger(c.exitCode) ? c.exitCode : null;
    const bad = (st === 'exited' && code !== null && code !== 0);
    const why = [c.exitReason, errText(c.lastError)].filter(Boolean).join(' - ');
    return h('span', { class: 'pill s-' + st + (bad ? ' bad' : ''), title: why || null },
      h('span', { class: 'dot', 'aria-hidden': 'true' }), (CTR_STATUS[st] || st) + (st === 'exited' && code !== null ? ' (' + code + ')' : ''),
      c.busy ? h('span', { class: 'spin', title: 'working...' }) : null,
      c.busy ? h('span', { class: 'sr-only' }, ' (working)') : null,
      why ? h('span', { class: 'sr-only' }, ': ' + why) : null);
  }
  function ctrTags(c) {
    const out = [];
    // the root filesystem (only from a manager that reports it)
    if (c.rootfs === 'disk') {
      out.push(h('span', { class: 'tag', title: 'Disk root: the image stays on a shared read-only disk; files the container changes are kept until it is removed'
        + (Number.isFinite(c.rootDiskBytes) ? ' (writable layer ' + fmtBytes(c.rootDiskBytes) + ')' : '') }, 'Disk'));
    } else if (c.rootfs === 'ram') {
      out.push(h('span', { class: 'tag', title: 'RAM root: the whole image is held in memory and resets at every start' }, 'RAM'));
    }
    if (c.ephemeral) out.push(h('span', { class: 'tag temp', title: 'Removed by "Delete all temporary containers"' }, 'temporary'));
    if (/^(mcp|claude)/.test(c.createdBy || '')) out.push(h('span', { class: 'tag claude', title: 'Started by Claude through the MCP server' }, 'Claude'));
    if (c.autostart) out.push(h('span', { class: 'tag', title: 'Starts with the manager' }, 'autostart'));
    if (c.pendingRestart) out.push(h('span', { class: 'tag warn', title: 'Changed settings apply on the next start' }, 'restart pending'));
    if (c.lost) out.push(h('span', { class: 'tag err', title: 'Its QEMU still runs but its details were lost - Stop ends it' }, 'record lost'));
    if (c.paused) out.push(h('span', { class: 'tag err', title: errText(c.paused) }, 'paused: disk full'));
    if (c.fallback) out.push(h('span', { class: 'tag warn', title: errText(c.fallback.reason) || 'Docker inside a VM is suggested for this image' }, 'try Docker-in-VM'));
    return out;
  }
  function firstTcpPort(c) {
    const p = (c.ports || []).find((x) => x && isPort(x.host) && x.proto !== 'udp');
    return p ? p.host : null;
  }

  const CTRROWS = new Map();
  let ctrBody = null;
  function renderContainers(s) {
    const cs = Array.from(CTRS.values());
    const box = $('#ctrTable');
    const live = cs.filter(ctrLive).length;
    setText($('#ctrCount'), cs.length ? live + ' running of ' + cs.length : '');
    $('#btnCleanCtr').hidden = !cs.some((c) => c.ephemeral);
    if (!cs.length) {
      if (box.dataset.mode !== 'empty') {
        box.dataset.mode = 'empty';
        CTRROWS.clear();
        setChildren(box, h('div', { class: 'empty' }, 'No containers yet - run a Docker image above. Each one runs in its own small VM.'));
      }
      return;
    }
    if (box.dataset.mode !== 'table') {
      box.dataset.mode = 'table';
      CTRROWS.clear();
      ctrBody = h('tbody');
      setChildren(box, h('div', { class: 'tablewrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Name', 'Image', 'Status', 'Ports', 'Uptime', 'Memory'].map((x) => h('th', { scope: 'col' }, x)),
          h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
        ctrBody)));
    }
    const rows = cs.map((c) => {
      let r = CTRROWS.get(c.id);
      if (!r) { r = makeCtrRow(c.id); CTRROWS.set(c.id, r); }
      updateCtrRow(r, c);
      return r;
    });
    for (const [id, r] of CTRROWS) if (!CTRS.has(id)) { r.tr.remove(); CTRROWS.delete(id); }
    const cur = Array.from(ctrBody.children);
    if (cur.length !== rows.length || rows.some((r, i) => cur[i] !== r.tr)) {
      keepFocus(() => { for (const r of rows) ctrBody.appendChild(r.tr); });
    }
  }
  function makeCtrRow(id) {
    const r = { id: id };
    r.name = h('b');
    r.tags = h('span');
    r.image = h('td', { class: 'mono breakall' });
    r.pill = h('span', { class: 'pill' });
    r.ports = h('td');
    r.up = h('td', { class: 'mono' });
    r.mem = h('td', { class: 'mono' });
    r.act = h('div', { class: 'btns' });
    r.tr = h('tr', null, h('td', null, r.name, r.tags), r.image, h('td', null, r.pill), r.ports, r.up, r.mem, h('td', null, r.act));
    return r;
  }
  function updateCtrRow(r, c) {
    const sel = CTRD.id === c.id;
    r.tr.classList.toggle('sel', sel);
    if (sel) r.tr.setAttribute('aria-current', 'true'); else r.tr.removeAttribute('aria-current');
    setText(r.name, c.name || c.id);
    const tagKey = [c.ephemeral, c.createdBy, c.autostart, !!c.fallback, c.pendingRestart, c.lost, c.rootfs, c.rootDiskBytes, c.paused].join('|');
    if (r.tagKey !== tagKey) { r.tagKey = tagKey; setChildren(r.tags, ctrTags(c)); }
    setText(r.image, c.image || '');
    const pillKey = [c.status, c.exitCode, !!c.busy, c.exitReason, errText(c.lastError)].join('|');
    if (r.pillKey !== pillKey) {
      r.pillKey = pillKey;
      const pill = ctrPill(c);
      r.pill.replaceWith(pill);
      r.pill = pill;
    }
    const portKey = JSON.stringify([c.ports, lanAddrs()]);
    if (r.portKey !== portKey) {
      r.portKey = portKey;
      const nodes = ctrPortNodes(c.ports);
      setChildren(r.ports, nodes.length ? nodes : h('span', { class: 'small' }, '-'));
    }
    if (c.status === 'running' && c.startedAt) setText(r.up, fmtDur(secondsSince(c.startedAt)));
    else if (!ctrLive(c) && c.endedAt) setText(r.up, 'ended ' + ago(c.endedAt));
    else setText(r.up, '-');
    setText(r.mem, Number.isFinite(c.mem) ? c.mem + ' MB' : '-');
    const actKey = [c.status, !!c.busy, ctrStopping(c.id), firstTcpPort(c), c.name].join('|');
    if (r.actKey !== actKey) { r.actKey = actKey; keepFocusIn(r.act, () => setChildren(r.act, ctrRowActions(c))); }
  }
  function openLink(port, name) {
    return h('a', { class: 'btnlink', href: 'http://127.0.0.1:' + port + '/', target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open ' + name + ' in a new tab' }, 'Open');
  }
  function ctrRowActions(c) {
    const id = c.id, n = c.name || id, out = [];
    const port = firstTcpPort(c);
    if (c.status === 'running' && port) out.push(openLink(port, n));
    out.push(btn('Logs', 'sm', { fk: 'clog:' + id, aria: 'Logs of ' + n, onClick: () => selectCtr(id, 'logs') }));
    if (ctrLive(c)) {
      out.push(btn('Stop', 'sm', { fk: 'cstop:' + id, aria: 'Stop ' + n, disabled: c.status === 'stopping' || ctrStopping(id), onClick: (b) => stopCtr(b, c) }));
    } else {
      out.push(btn('Start', 'sm primary', { fk: 'cstart:' + id, aria: 'Start ' + n, disabled: !!c.busy, onClick: (b) => startCtr(b, c) }));
    }
    out.push(btn('Remove', 'sm danger-outline', { fk: 'crm:' + id, aria: 'Remove ' + n, disabled: ctrStopping(id), onClick: (b) => removeCtr(b, c) }));
    out.push(btn('Manage', 'sm', { fk: 'cman:' + id, aria: 'Manage ' + n, onClick: () => selectCtr(id) }));
    return out;
  }

  // ---- container actions ----
  function startCtr(b, c) {
    return runTask('/api/container/start', { id: c.id }, { btn: b });
  }
  function stopCtr(b, c) {
    return runTask('/api/container/stop', { id: c.id }, { btn: b });
  }
  async function forceStopCtr(b, c) {
    if (!await confirmDialog('Force stop "' + (c.name || c.id) + '"?',
      'The app gets no time to finish: it is killed at once. Data in volumes is still written out before the VM ends. Use Stop unless the container hangs.', 'Force stop')) return;
    runTask('/api/container/stop', { id: c.id, force: true }, { btn: b });
  }
  // running: stop, then start again with the same settings
  async function restartCtr(b, c) {
    const t = await runTask('/api/container/stop', { id: c.id }, { btn: b, quiet: true });
    if (!t) return;
    if (t.status !== 'done') { toast('Could not stop "' + (c.name || c.id) + '": ' + firstLine(t.error), 'err'); return; }
    runTask('/api/container/start', { id: c.id }, { btn: b });
  }
  async function removeCtr(b, c) {
    const live = ctrLive(c), n = c.name || c.id;
    if (!await confirmDialog('Remove the container "' + n + '"?',
      (live ? 'It is stopped first. ' : '') + 'Its record and logs are deleted and its ports are freed. '
      + 'Volumes are kept (remove them under Volumes), and folders shared from this PC are not touched.', 'Remove container')) return false;
    const undo = busyButton(b);
    try {
      const body = { id: c.id };
      if (live) body.force = true;
      await postMaybeTask('/api/container/remove', body, { quiet: true });
      toast('Removed the container "' + n + '"', 'ok');
      if (CTRD.id === c.id) closeCtrDetail();
      pokePoll(0);
      return true;
    } catch (e) {
      if (!e.auth) toast('Could not remove "' + n + '": ' + e.message, 'err');
      return false;
    } finally {
      undo();
    }
  }
  async function deleteTempCtrs(b) {
    const temps = Array.from(CTRS.values()).filter((c) => c.ephemeral);
    if (!temps.length) return;
    const ok = await confirmDialog('Delete all ' + temps.length + ' temporary container' + (temps.length === 1 ? '' : 's') + '?',
      'These containers are removed (running ones are stopped first). Their volumes are kept:\n\n'
      + temps.map((c) => '  ' + (c.name || c.id) + (ctrLive(c) ? '  (' + (CTR_STATUS[c.status] || c.status) + ')' : '')).join('\n'),
      'Delete ' + temps.length + ' container' + (temps.length === 1 ? '' : 's'));
    if (!ok) return;
    const undo = busyButton(b);
    const failed = [];
    let removed = 0;
    await Promise.all(temps.map(async (c) => {
      try {
        const body = { id: c.id };
        if (ctrLive(c)) body.force = true;
        await postMaybeTask('/api/container/remove', body, { quiet: true });
        removed++;
      } catch (e) { failed.push((c.name || c.id) + ': ' + e.message); }
    }));
    undo();
    // an open detail panel of a removed container closes with the next poll
    if (failed.length) toast('Deleted ' + removed + ' of ' + temps.length + ' temporary containers. Not deleted:\n' + failed.join('\n'), 'err');
    else toast('Deleted ' + removed + ' temporary container' + (removed === 1 ? '' : 's'), 'ok');
    pokePoll(0);
  }
  async function sendSignal(b, c, sig) {
    const undo = busyButton(b);
    try {
      await post('/api/container/kill', { id: c.id, signal: sig });
      toast('Sent ' + sig + ' to "' + (c.name || c.id) + '"', 'ok');
      pokePoll(500);
    } catch (e) {
      if (!e.auth) toast('Could not send the signal: ' + e.message, 'err');
    } finally {
      undo();
    }
  }
  async function showEnvValues(b, id) {
    const undo = busyButton(b);
    try {
      const j = await api('/api/container?id=' + encodeURIComponent(id) + '&reveal=1');
      const rec = j.container && typeof j.container === 'object' ? j.container : j;
      const env = Array.isArray(rec.env) ? rec.env.map(String) : [];
      openModal({
        title: 'Environment of "' + (rec.name || id) + '"', wide: true,
        hint: 'These values can be secrets (passwords, keys). They are stored in the manager\'s private data folder and only shown on request.',
        content: h('pre', { tabindex: '0', 'aria-label': 'Environment variables' }, env.length ? env.join('\n') : '(none set - only the image\'s own defaults apply)'),
        submitLabel: 'Close', cancelLabel: null,
      });
    } catch (e) {
      if (!e.auth) toast(notImpl(e) ? 'Not available in this version of the manager yet.' : e.message, 'err');
    } finally {
      undo();
    }
  }

  // ===========================================================================
  // container detail panel - keyed by container id; the full record comes
  // from GET /api/container while it is open
  // ===========================================================================
  const CTRD = { id: null, tab: 'overview', rec: null, fseq: 0, fetching: false, last: 0, sumKey: '', ovKey: '', upEl: null, na: false, fetchErr: null, shareSt: null };
  const CTABS = ['overview', 'logs', 'settings'];
  function selectCtr(id, tab) {
    if (!CTRS.has(id)) { toast('That container no longer exists', 'err'); return; }
    const changed = id !== CTRD.id;
    if (changed) { leaveCtr(); CTRD.id = id; }
    $('#ctrDetail').hidden = false;
    showCtab(tab || (changed ? 'overview' : CTRD.tab), changed);
    renderCtrDetail();
    if (changed) ctrdFetch(true);
    markCtrRows();
    if (changed || tab) $('#ctrDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  // everything that belonged to the previous container goes: its log
  // stream, the fetched record, a half-edited settings form
  function leaveCtr() {
    clogStop();
    CTRD.fseq++;
    CTRD.fetching = false;
    CTRD.rec = null;
    CTRD.sumKey = '';
    CTRD.ovKey = '';
    CTRD.last = 0;
    CTRD.na = false;
    CTRD.fetchErr = null;
    CTRD.shareSt = null;
    setText($('#clLog'), '');
    setText($('#clStatus'), '');
    $('#clPrev').checked = false;
    csReset();
  }
  function closeCtrDetail() {
    leaveCtr();
    CTRD.id = null;
    $('#ctrDetail').hidden = true;
    markCtrRows();
  }
  function markCtrRows() {
    for (const r of CTRROWS.values()) {
      const on = r.id === CTRD.id;
      r.tr.classList.toggle('sel', on);
      if (on) r.tr.setAttribute('aria-current', 'true'); else r.tr.removeAttribute('aria-current');
    }
  }
  function showCtab(which, fresh) {
    if (CTABS.indexOf(which) === -1) which = 'overview';
    const prev = CTRD.tab;
    CTRD.tab = which;
    for (const t of CTABS) {
      const on = t === which;
      const b = $('#ctab-' + t);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      $('#cp-' + t).hidden = !on;
    }
    if (which === 'logs' && (prev !== 'logs' || fresh)) clogLoad();
    if (which !== 'logs') clogStop();
    if (which === 'settings') csFill(fresh);
    if (which === 'overview' && Date.now() - CTRD.last > 3000) ctrdFetch(false);
  }
  function onCtabKey(e) {
    const i = CTABS.indexOf(CTRD.tab);
    let n = null;
    if (e.key === 'ArrowRight') n = CTABS[(i + 1) % CTABS.length];
    else if (e.key === 'ArrowLeft') n = CTABS[(i - 1 + CTABS.length) % CTABS.length];
    else if (e.key === 'Home') n = CTABS[0];
    else if (e.key === 'End') n = CTABS[CTABS.length - 1];
    if (!n) return;
    e.preventDefault();
    showCtab(n);
    $('#ctab-' + n).focus();
  }

  async function ctrdFetch(force) {
    const id = CTRD.id;
    if (!id || document.hidden) return;
    if (CTRD.fetching && !force) return;
    const seq = ++CTRD.fseq;
    CTRD.fetching = true;
    CTRD.last = Date.now();
    try {
      const j = await api('/api/container?id=' + encodeURIComponent(id));
      if (seq !== CTRD.fseq || id !== CTRD.id) return;
      CTRD.rec = j.container && typeof j.container === 'object' ? j.container : j;
      CTRD.na = false;
      CTRD.fetchErr = null;
      // live status of its shared folders (only while it runs)
      const shares = Array.isArray(CTRD.rec.shares) ? CTRD.rec.shares : [];
      const c = CTRS.get(id);
      if (shares.length && c && c.status === 'running') {
        try {
          const sj = await api('/api/shares?owner=' + encodeURIComponent(id));
          if (seq !== CTRD.fseq) return;
          const m = new Map();
          for (const s of Array.isArray(sj.shares) ? sj.shares : []) if (s && s.guestPath) m.set(s.guestPath, s.status && typeof s.status === 'object' ? s.status : s);
          CTRD.shareSt = m;
        } catch (e) { CTRD.shareSt = null; }
      } else CTRD.shareSt = null;
    } catch (e) {
      if (seq !== CTRD.fseq || id !== CTRD.id || e.auth) return;
      CTRD.na = notImpl(e);
      CTRD.fetchErr = CTRD.na ? null : e.message;
    } finally {
      if (seq === CTRD.fseq) CTRD.fetching = false;
    }
    if (id === CTRD.id) {
      renderCtrDetail();
      if (CTRD.tab === 'settings') csFill(false);
    }
  }

  function renderCtrDetail() {
    if (!CTRD.id) return;
    const c = CTRS.get(CTRD.id);
    if (!c) { closeCtrDetail(); return; } // removed (here or elsewhere)
    const titleKey = JSON.stringify([c.name, c.status, c.exitCode, !!c.busy, c.ephemeral, c.createdBy, c.autostart, !!c.fallback, c.pendingRestart, c.lost, c.rootfs, c.rootDiskBytes, c.paused]);
    if ($('#cdTitle').dataset.key !== titleKey) {
      $('#cdTitle').dataset.key = titleKey;
      setChildren($('#cdTitle'), c.name || c.id, h('span', { class: 'mono' }, c.id));
      setChildren($('#cdBadges'), ctrPill(c), ctrTags(c));
    }
    // the record behind the summary changed: fetch it again
    const sumKey = JSON.stringify([c.status, c.exitCode, c.busy, c.ports, c.startedAt, c.name]);
    if (sumKey !== CTRD.sumKey) {
      const first = !CTRD.sumKey;
      CTRD.sumKey = sumKey;
      if (!first) ctrdFetch(true);
      // a log view that ended with the old run follows the new one
      if (!first && CTRD.tab === 'logs' && $('#clFollow').checked && !CLOG.es && c.status === 'running') clogLoad();
    } else if (CTRD.tab === 'overview' && Date.now() - CTRD.last > 10000) ctrdFetch(false);
    renderCtrOverview(c);
  }

  function kvList(items) {
    return items.length ? items.map((x) => h('div', null, x)) : h('span', { class: 'small' }, 'none');
  }
  function fmtMs(ms) { return Number.isFinite(ms) ? (ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s') : null; }
  function renderCtrOverview(c) {
    const rec = CTRD.rec || {};
    const busyTask = c.busy ? TASKS.byId.get(c.busy) : null;
    const stopping = ctrStopping(c.id);
    const key = JSON.stringify([c, rec, CTRD.shareSt ? Array.from(CTRD.shareSt.entries()) : null, CTRD.na, CTRD.fetchErr,
      busyTask && busyTask.title, busyTask && busyTask.step, stopping, lanAddrs()]);
    if (key !== CTRD.ovKey) {
      CTRD.ovKey = key;
      renderCtrActions(c, stopping);
      // the Docker-in-VM offer, when the engine suggested it
      const fb = rec.fallback || c.fallback || null;
      const fbox = $('#cdFallback');
      fbox.hidden = !fb;
      if (fb) {
        const mem = fb.code === 'NEEDS_MEMORY' && Number.isInteger(fb.memMB) ? fb.memMB : null;
        setChildren(fbox, h('div', { class: 'ftxt' }, h('b', null, mem ? 'This container ran out of memory. ' : 'The microVM engine suggests Docker inside a VM for this image. '), errText(fb.reason) || errText(fb)),
          mem ? btn('Run with ' + mem + ' MB', 'sm primary', { fk: 'cfbm', disabled: ctrLive(c), onClick: (b) => runWithMemory(b, c.id, mem) }) : null,
          btn('Run with Docker-in-VM instead', mem ? 'sm' : 'sm primary', { fk: 'cfb', onClick: (b) => offerFallback({ id: c.id, name: c.name, image: c.image, reason: errText(fb.reason), btn: b }) }));
      }
      const kids = [];
      const kv = (k, val) => kids.push(h('div', { class: 'k' }, k), h('div', { class: 'v' }, val));
      kv('Status', [ctrPill(c), busyTask ? h('span', { class: 'small' }, '  ' + (busyTask.title || 'working') + (busyTask.step ? ': ' + busyTask.step : '')) : null]);
      kv('Image', [h('span', { class: 'mono' }, c.image || rec.image || ''),
        rec.reference && rec.reference !== c.image ? h('div', { class: 'small breakall' }, rec.reference) : null,
        rec.configDigest ? h('div', { class: 'small mono breakall', title: rec.configDigest }, 'config ' + String(rec.configDigest).slice(0, 19) + '...') : null]);
      const pn = ctrPortNodes(c.ports);
      kv('Ports', pn.length ? pn : h('span', { class: 'small' }, 'none published'));
      // edited while it runs: published at its next start (correct-8)
      if (Array.isArray(c.pendingPorts)) {
        kv('Ports at next start', c.pendingPorts.length ? h('span', { class: 'mono' }, c.pendingPorts.map((p) => p.host + ' → ' + p.guest + (p.proto === 'udp' ? '/udp' : '') + (p.lan ? ' (LAN)' : '')).join(', '))
          : h('span', { class: 'small' }, 'none'));
      }
      const vols = Array.isArray(rec.volumes) ? rec.volumes : [];
      if (vols.length || rec.volumes) {
        kv('Volumes', kvList(vols.filter((v) => v && typeof v === 'object').map((v) => [h('span', { class: 'mono' }, v.name || v.hostDir || ''), ' → ', h('span', { class: 'mono' }, v.target || ''),
          v.readonly ? h('span', { class: 'tag' }, 'read-only') : null, v.nocopy ? h('span', { class: 'tag' }, 'no copy-up') : null])));
      }
      const shares = Array.isArray(rec.shares) ? rec.shares : [];
      if (shares.length) {
        kv('Shared folders', kvList(shares.map((s) => {
          const st = CTRD.shareSt ? CTRD.shareSt.get(s.guestPath) : null;
          const why = c.status === 'running' ? closeReasonOf(st) : null;
          return [h('span', { class: 'mono' }, s.hostPath || ''), ' → ', h('span', { class: 'mono' }, s.guestPath || ''),
            s.readOnly ? h('span', { class: 'tag' }, 'read-only') : null, ' ', shareChipFor(st, c.status === 'running'),
            why ? h('div', { class: 'small' }, why) : null];
        })));
      }
      const cin = Array.isArray(rec.copyIn) ? rec.copyIn : [];
      if (cin.length) {
        kv('Copied in at every start', kvList(cin.filter((x) => x && typeof x === 'object').map((x) => [h('span', { class: 'mono' }, x.hostDir || x.hostPath || ''), ' → ',
          h('span', { class: 'mono' }, x.target || x.guestPath || '')])));
      }
      const envNames = (Array.isArray(rec.env) ? rec.env : []).map((e) => String(e).split('=')[0]).filter(Boolean);
      kv('Environment', [envNames.length ? h('span', { class: 'mono' }, envNames.join(', ')) : h('span', { class: 'small' }, 'only the image defaults'),
        envNames.length ? btn('Show values', 'sm', { fk: 'cenv', aria: 'Show the environment values', onClick: (b) => showEnvValues(b, c.id) }) : null]);
      const argv = (x) => (Array.isArray(x) ? x.map((a) => (/[\s'"]/.test(a) || a === '' ? JSON.stringify(a) : a)).join(' ') : null);
      if (rec.entrypoint || rec.cmd) kv('Command', h('span', { class: 'mono breakall' }, [argv(rec.entrypoint), argv(rec.cmd)].filter((x) => x !== null && x !== '').join(' ') || '(empty)'));
      if (rec.user || rec.workdir) kv('User / folder', h('span', { class: 'mono' }, (rec.user || 'image default') + '  ·  ' + (rec.workdir || 'image default')));
      const rt = rec.runtime && typeof rec.runtime === 'object' ? rec.runtime : null;
      const rfs = ctrRootfs(c, rec);
      kv('Memory / vCPUs', (rt && rt.memMB ? rt.memMB : (Number.isFinite(c.mem) ? c.mem : (rec.mem || 'automatic'))) + ' MB / ' + ((rt && rt.cpus) || rec.cpus || 1) + ' vCPU'
        + (rec.mem ? '' : (rfs === 'ram' ? ' (memory sized to the image)' : (rfs === 'disk' ? ' (the default for disk-root containers)' : ''))));
      if (rfs) kv('Root filesystem', rootfsNodes(c, rec, rfs));
      if (rt && (rt.effectiveAccel || rt.accel)) {
        const acc = rt.effectiveAccel || rt.accel;
        kv('Acceleration', [h('b', null, accelName(acc)), acc === 'tcg' ? ' - software emulation: slower, and not a security boundary' : ' - hardware accelerated',
          rt.machine ? h('span', { class: 'small' }, '   machine ' + rt.machine) : null]);
      }
      const upEl = h('span', { class: 'mono' });
      kv(ctrLive(c) ? 'Uptime' : 'Last run', upEl);
      CTRD.upEl = upEl;
      if (rec.createdAt) kv('Created', fmtDate(rec.createdAt) + (rec.createdBy ? ' by ' + (/^(mcp|claude)/.test(rec.createdBy) ? 'Claude' : rec.createdBy) : ''));
      const tm = rec.timings && typeof rec.timings === 'object' ? rec.timings : null;
      if (tm) {
        const parts = [['pull', tm.pullMs], ['unpack', tm.flattenMs], ['image disk', tm.diskMs], ['initrd', tm.initrdMs], ['root mounted', tm.rootMs],
          ['ready', tm.readyMs], ['first answer', tm.firstResponseMs]]
          .filter((x) => Number.isFinite(x[1])).map((x) => x[0] + ' ' + fmtMs(x[1]));
        if (parts.length) kv('Timings', h('span', { class: 'mono' }, parts.join('  ·  ')));
      }
      const warns = (Array.isArray(rec.warnings) ? rec.warnings : []).map(errText).filter(Boolean);
      if (warns.length) kv('Warnings', kvList(warns.map((w) => h('span', { class: 'small' }, w))));
      if (rec.note) kv('Note', rec.note);
      if (CTRD.na) kv('Details', h('span', { class: 'small' }, 'Full details are not available in this version of the manager yet.'));
      else if (CTRD.fetchErr) kv('Details', h('span', { class: 'small' }, 'Could not read the details: ' + CTRD.fetchErr));
      keepFocusIn($('#cdKv'), () => setChildren($('#cdKv'), kids));
      // why it failed: the exit reason, the init's own messages (untrusted
      // guest text: shown as text, capped by the manager)
      const reason = c.exitReason || rec.exitReason || errText(rec.lastError) || errText(c.lastError);
      const failed = c.status === 'error' || (c.status === 'exited' && Number.isInteger(c.exitCode) && c.exitCode !== 0);
      const msgs = (Array.isArray(rec.initMessages) ? rec.initMessages : []).map((m) => String(m)).slice(-20);
      $('#cdError').hidden = !(failed && (reason || msgs.length));
      if (failed) {
        setText($('#cdErrMsg'), (Number.isInteger(c.exitCode) ? 'Exit code ' + c.exitCode + (EXIT_MEANING[c.exitCode] ? ' (' + EXIT_MEANING[c.exitCode] + ')' : '') + '. ' : '') + (reason || ''));
        $('#cdErrDetail').hidden = !msgs.length;
        setText($('#cdErrDetail'), msgs.join('\n'));
      }
      setText($('#cdHint'), ctrLive(c) ? 'Stop lets the app finish (it gets the stop signal, then a kill after the timeout); volumes are always written out before the VM ends.'
        : (rfs === 'disk' ? 'Start boots it again; files changed outside volumes are kept until you remove it or start it fresh.'
          : 'Start boots it again with the same settings. Files changed outside volumes and shared folders are reset: the container\'s root filesystem lives in memory.'));
    }
    if (CTRD.upEl) {
      setText(CTRD.upEl, c.status === 'running' && c.startedAt ? fmtDur(secondsSince(c.startedAt))
        : (!ctrLive(c) && (c.endedAt || rec.endedAt) ? 'ended ' + ago(c.endedAt || rec.endedAt) + (Number.isInteger(c.exitCode) ? ', exit code ' + c.exitCode : '') : '-'));
    }
  }
  // The root filesystem a container runs with (while it runs) or is set to,
  // or null from a manager that does not report one.
  function ctrRootfs(c, rec) {
    const rt = rec && rec.runtime && typeof rec.runtime === 'object' ? rec.runtime : null;
    const v = (ctrLive(c) && rt && rt.rootfs) || (rec && rec.rootfs) || c.rootfs || null;
    return v === 'disk' || v === 'ram' ? v : null;
  }
  // its writable layer on this PC (disk root), in bytes, or null
  function layerBytes(c, rec) {
    if (Number.isFinite(c.rootDiskBytes)) return c.rootDiskBytes;
    const d = rec && rec.rootDisk && typeof rec.rootDisk === 'object' ? rec.rootDisk : null;
    return d && Number.isFinite(d.overlayBytes) ? d.overlayBytes : null;
  }
  function rootfsNodes(c, rec, rfs) {
    const out = [];
    if (rfs === 'disk') {
      const b = layerBytes(c, rec);
      out.push(h('b', null, 'Disk'), ' - the image stays on a shared read-only disk; ',
        b !== null ? 'writable layer ' + fmtBytes(b) + ', kept until the container is removed' : 'its writable layer is made at its first start');
    } else {
      out.push(h('b', null, 'RAM'), ' - the whole image is held in memory and resets at every start');
    }
    // switched in Settings while it runs: applies at the next start
    const want = rec && (rec.rootfs === 'disk' || rec.rootfs === 'ram') ? rec.rootfs : null;
    if (want && want !== rfs) {
      out.push(h('div', { class: 'small' }, 'Becomes ' + (want === 'ram' ? 'RAM' : 'Disk') + ' at the next start'
        + (want === 'ram' ? ' - the writable layer is dropped then' : '') + '.'));
    }
    return out;
  }
  // Disk root, stopped: boot it from the clean image again (spec 6.2 fresh)
  async function startFresh(b, c) {
    if (!await confirmDialog('Start "' + (c.name || c.id) + '" fresh?',
      'Drops every change outside volumes and shared folders, like removing and re-running it. The image is looked up again.', 'Start fresh')) return;
    runTask('/api/container/start', { id: c.id, fresh: true }, { btn: b });
  }
  // Docker-compatible exit codes (microVM spec 6.3)
  const EXIT_MEANING = {
    125: 'the engine could not run it', 126: 'the command cannot be run (not executable, or the user does not exist)',
    127: 'command not found', 130: 'interrupted (INT)', 132: 'illegal instruction - the CPU lacks a feature the app needs',
    137: 'killed (KILL)', 139: 'segmentation fault', 143: 'stopped (TERM)',
  };
  const SIGNALS = ['TERM', 'INT', 'HUP', 'QUIT', 'USR1', 'USR2', 'KILL'];
  function renderCtrActions(c, stopping) {
    const box = $('#cdActions'), out = [];
    const busy = !!c.busy, n = c.name || c.id;
    const port = firstTcpPort(c);
    if (c.status === 'running' && port) out.push(openLink(port, n));
    if (ctrLive(c)) {
      out.push(btn('Stop', 'sm', { fk: 'cd-stop', disabled: stopping || c.status === 'stopping', onClick: (b) => stopCtr(b, c) }));
      // stays usable while a graceful stop waits for an app that hangs
      out.push(btn('Force stop', 'sm danger-outline', { fk: 'cd-force', onClick: (b) => forceStopCtr(b, c) }));
      if (c.status === 'running') out.push(btn('Restart', 'sm', { fk: 'cd-restart', disabled: busy || stopping, onClick: (b) => restartCtr(b, c) }));
      if (c.status === 'running') {
        const sel = h('select', { class: 'auto', 'aria-label': 'Signal to send' }, SIGNALS.map((s) => h('option', { value: s }, s)));
        out.push(h('span', { class: 'inrow' }, sel, btn('Send signal', 'sm', { fk: 'cd-sig', onClick: (b) => sendSignal(b, c, sel.value) })));
      }
    } else {
      out.push(btn('Start', 'sm primary', { fk: 'cd-start', disabled: busy, onClick: (b) => startCtr(b, c) }));
      if (ctrRootfs(c, CTRD.rec) === 'disk') out.push(btn('Start fresh', 'sm', { fk: 'cd-fresh', disabled: busy, aria: 'Start ' + n + ' fresh, dropping its changed files', onClick: (b) => startFresh(b, c) }));
    }
    out.push(btn('Logs', 'sm', { fk: 'cd-logs', onClick: () => showCtab('logs') }));
    out.push(btn('Remove', 'sm danger-outline', { fk: 'cd-rm', disabled: stopping, onClick: (b) => removeCtr(b, c) }));
    keepFocusIn(box, () => setChildren(box, out));
  }

  // ---- container logs: last part by GET, then follow over SSE ----
  // The stream sends {t: text, n: byte offset after it}; a reconnect asks
  // with ?since=<n>, so nothing is shown twice. {exit: code} ends it.
  const CLOG = { gen: 0, es: null, since: null, timer: null, retries: 0, len: 0 };
  const CLOG_MAX = 600000;
  function clogStop() {
    CLOG.gen++;
    clearTimeout(CLOG.timer);
    CLOG.timer = null;
    if (CLOG.es) { try { CLOG.es.close(); } catch (e) { /* closed */ } CLOG.es = null; }
  }
  function clogSetText(text) {
    const pre = $('#clLog');
    pre.textContent = text;
    CLOG.len = text.length;
    pre.scrollTop = pre.scrollHeight;
  }
  function clogAppend(text) {
    const pre = $('#clLog');
    const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
    if (CLOG.len + text.length > CLOG_MAX) {
      // keep the newest part: a chatty app must not grow the page forever
      const keep = (pre.textContent + text).slice(-Math.floor(CLOG_MAX * 0.7));
      pre.textContent = keep;
      CLOG.len = keep.length;
    } else {
      pre.appendChild(document.createTextNode(text));
      CLOG.len += text.length;
    }
    if (atEnd && !selectionIn(pre)) pre.scrollTop = pre.scrollHeight;
  }
  function clogQuery(extra) {
    return '?id=' + encodeURIComponent(CTRD.id) + '&stream=' + encodeURIComponent($('#clStream').value) + (extra || '');
  }
  async function clogLoad() {
    clogStop();
    const gen = CLOG.gen, id = CTRD.id;
    if (!id) return;
    // the QEMU log of an earlier boot is not kept (only the app's streams)
    const qemu = $('#clStream').value === 'qemu';
    if (qemu) $('#clPrev').checked = false;
    $('#clPrev').disabled = qemu;
    const prev = $('#clPrev').checked;
    setText($('#clStatus'), 'Loading...');
    if ($('#clStream').value === 'both') return clogLoadBoth(gen, id, prev);
    let j;
    try {
      j = await api('/api/container/logs' + clogQuery('&tail=1000&prev=' + (prev ? 1 : 0)));
    } catch (e) {
      if (gen !== CLOG.gen || e.auth) return;
      clogSetText('');
      setText($('#clStatus'), notImpl(e) ? 'Container logs are not available in this version of the manager yet.' : 'Could not read the log: ' + e.message);
      return;
    }
    if (gen !== CLOG.gen || id !== CTRD.id) return;
    clogSetText(typeof j.text === 'string' && j.text ? j.text : '');
    CLOG.since = Number.isFinite(j.size) ? j.size : null;
    const c = CTRS.get(id);
    const follow = $('#clFollow').checked && !prev && CLOG.since !== null && c && ctrLive(c);
    if (follow) { CLOG.retries = 0; clogStream(gen); }
    else {
      setText($('#clStatus'), (j.text ? '' : 'Empty. ') + (j.truncated ? 'Showing the newest part. ' : '')
        + (prev ? 'Previous run.' : (c && !ctrLive(c) ? 'The container is not running.' : '')));
    }
  }
  // stdout and stderr together (spec 12.3): two labelled sections; while
  // the container runs and Follow is on, both are read again every 3 s
  // (the live stream follows one file at a time)
  async function clogLoadBoth(gen, id, prev) {
    const q = (s) => '/api/container/logs?id=' + encodeURIComponent(id) + '&stream=' + s + '&tail=1000&prev=' + (prev ? 1 : 0);
    let o, e;
    try { [o, e] = await Promise.all([api(q('stdout')), api(q('stderr'))]); }
    catch (err) {
      if (gen !== CLOG.gen || err.auth) return;
      setText($('#clStatus'), 'Could not read the log: ' + err.message);
      return;
    }
    if (gen !== CLOG.gen || id !== CTRD.id) return;
    const pre = $('#clLog');
    const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    const part = (label, j) => '=== ' + label + (j.truncated ? ' (newest part)' : '') + ' ===\n' + (typeof j.text === 'string' && j.text ? j.text.replace(/\n?$/, '\n') : '(empty)\n');
    const text = part('Output (stdout)', o) + '\n' + part('Errors (stderr)', e);
    if (text !== pre.textContent && !selectionIn(pre)) {
      const top = pre.scrollTop;
      pre.textContent = text;
      CLOG.len = text.length;
      pre.scrollTop = atEnd ? pre.scrollHeight : top;
    }
    const c = CTRS.get(id);
    const live = !prev && c && ctrLive(c);
    if ($('#clFollow').checked && live) {
      setText($('#clStatus'), 'Both streams, read again every 3 s.');
      CLOG.timer = setTimeout(() => { if (gen === CLOG.gen) clogLoadBoth(gen, id, prev); }, 3000);
    } else {
      setText($('#clStatus'), prev ? 'Previous run.' : (c && !live ? 'The container is not running.' : ''));
    }
  }
  function clogStream(gen) {
    if (gen !== CLOG.gen || !CTRD.id) return;
    const url = '/api/container/logs/stream' + clogQuery('&since=' + CLOG.since + '&token=' + encodeURIComponent(TOKEN || ''));
    let es;
    try { es = new EventSource(url); } catch (e) { setText($('#clStatus'), 'Could not follow the log.'); return; }
    CLOG.es = es;
    es.onopen = () => { if (gen === CLOG.gen) { CLOG.retries = 0; setText($('#clStatus'), 'Following - new lines appear as they are written.'); } };
    es.onmessage = (ev) => {
      if (gen !== CLOG.gen) return;
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      // the log file was replaced by a new boot: start the view over
      if (m.reset) { clogSetText(''); CLOG.since = Number.isFinite(m.n) ? m.n : 0; }
      if (typeof m.t === 'string' && m.t) clogAppend(m.t);
      if (Number.isFinite(m.n) && m.n > CLOG.since) CLOG.since = m.n;
      if (m.exit !== undefined) {
        es.close();
        if (CLOG.es === es) CLOG.es = null;
        setText($('#clStatus'), 'The container stopped' + (Number.isInteger(m.exit) ? ' (exit code ' + m.exit + ')' : '') + '.');
      }
    };
    es.onerror = () => {
      es.close();
      if (CLOG.es === es) CLOG.es = null;
      if (gen !== CLOG.gen) return;
      CLOG.retries++;
      if (CLOG.retries > 20) { setText($('#clStatus'), 'Stopped following (the connection kept dropping) - press Reload.'); return; }
      setText($('#clStatus'), 'Connection interrupted - reconnecting...');
      CLOG.timer = setTimeout(() => clogStream(gen), Math.min(5000, 700 * CLOG.retries));
    };
  }
  async function clogDownload(b) {
    const id = CTRD.id, c = CTRS.get(id);
    if (!id) return;
    const undo = busyButton(b);
    try {
      const stream = $('#clStream').value, prev = $('#clPrev').checked;
      let j;
      if (stream === 'both') {
        const q = (s) => '/api/container/logs?id=' + encodeURIComponent(id) + '&stream=' + s + '&tail=5000&prev=' + (prev ? 1 : 0);
        const [o, e] = await Promise.all([api(q('stdout')), api(q('stderr'))]);
        j = { text: '=== stdout ===\n' + (o.text || '') + '\n=== stderr ===\n' + (e.text || ''), truncated: !!(o.truncated || e.truncated) };
      } else j = await api('/api/container/logs' + clogQuery('&tail=5000&prev=' + (prev ? 1 : 0)));
      const url = URL.createObjectURL(new Blob([j.text || ''], { type: 'text/plain;charset=utf-8' }));
      const safe = String((c && c.name) || id).replace(/[^A-Za-z0-9_.-]/g, '_');
      const a = h('a', { href: url, download: safe + '-' + stream + (prev ? '-previous' : '') + '.log', hidden: true });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      if (j.truncated) toast('Saved the newest part of the log (the manager sends at most the last 256 KB).', 'ok');
    } catch (e) {
      if (!e.auth) toast(notImpl(e) ? 'Container logs are not available in this version of the manager yet.' : e.message, 'err');
    } finally {
      undo();
    }
  }

  // ---- container settings: applies at the next start ----
  const CS = { orig: null, dirty: false, ports: null };
  function csReset() {
    CS.orig = null;
    CS.dirty = false;
    hideErr($('#csErr'));
    setText($('#csStatus'), '');
    for (const id of ['#csName', '#csNote', '#csMem', '#csCpu']) $(id).value = '';
    $('#csAuto').checked = false;
    $('#csRm').checked = false;
    $('#csRootfs').value = 'disk';
    setText($('#csRootfsHint'), '');
    if (CS.ports) CS.ports.set([]);
  }
  function csSource() {
    const c = CTRS.get(CTRD.id);
    if (!c) return null;
    const rec = CTRD.rec || {};
    const rfs = rec.rootfs || c.rootfs;
    return {
      name: rec.name || c.name || '', note: rec.note || '', mem: Number.isInteger(rec.mem) ? rec.mem : null,
      // null: a manager that has no root filesystem choice (the select is hidden)
      rootfs: rfs === 'disk' || rfs === 'ram' ? rfs : null,
      cpus: Number.isInteger(rec.cpus) ? rec.cpus : null, autostart: !!(rec.autostart !== undefined ? rec.autostart : c.autostart),
      // an edit made while it runs is what the next start publishes
      autoRemove: !!rec.autoRemove, ports: (rec.pendingPorts || c.pendingPorts || rec.ports || c.ports || []).map((p) => ({ host: p.host, guest: p.guest, proto: p.proto === 'udp' ? 'udp' : 'tcp', lan: !!p.lan })),
    };
  }
  // never overwrites what the user is editing (UI-2)
  function csFill(force) {
    if (CS.dirty && !force) return;
    const s = csSource();
    if (!s) return;
    if (!force && CS.orig && JSON.stringify(CS.orig) === JSON.stringify(s)) return;
    CS.orig = s;
    CS.dirty = false;
    $('#csName').value = s.name;
    $('#csNote').value = s.note;
    $('#csMem').value = s.mem === null ? '' : String(s.mem);
    $('#csCpu').value = s.cpus === null ? '' : String(s.cpus);
    $('#csAuto').checked = s.autostart;
    $('#csRm').checked = s.autoRemove;
    $('#csRootfs').value = s.rootfs || 'disk';
    $('#csRootfs').parentElement.hidden = !s.rootfs;
    csRootfsHint();
    CS.ports.set(s.ports);
    $('#csUndo').disabled = true;
  }
  // what switching the root filesystem does (applies at the next start)
  function csRootfsHint() {
    const o = CS.orig;
    const v = $('#csRootfs').value;
    let t = '';
    if (o && o.rootfs && v !== o.rootfs) {
      t = v === 'ram' ? 'At the next start the container switches to a RAM root: its writable layer (files changed outside volumes) is dropped, and from then on it resets at every start.'
        : 'At the next start the container switches to a disk root: it gets a writable layer on the image disk, and its files are kept from then on until it is removed.';
    } else if (o && o.rootfs) t = ROOTFS_WHY[v === 'ram' ? 'ram' : 'disk'];
    setText($('#csRootfsHint'), t);
    setText($('#csMemHint'), o && o.rootfs ? memWhy(v) : '');
    syncMemMin();
  }
  function csDirty() { CS.dirty = true; $('#csUndo').disabled = false; }
  async function csSave(b) {
    const id = CTRD.id, err = $('#csErr');
    if (!id || !CS.orig) return;
    const L = limits();
    const o = CS.orig;
    const body = { id: id };
    const name = $('#csName').value.trim();
    if (name !== o.name) {
      if (!RE.vm.test(name)) return showErr(err, 'Name: use 1-63 letters, digits, ".", "_" or "-", starting with a letter or digit.', $('#csName'));
      body.name = name;
    }
    const note = $('#csNote').value;
    if (note !== o.note) body.note = note;
    const memRaw = $('#csMem').value.trim(), cpuRaw = $('#csCpu').value.trim();
    const mem = memRaw ? toInt(memRaw) : null, cpus = cpuRaw ? toInt(cpuRaw) : null;
    const rootfs = o.rootfs ? ($('#csRootfs').value === 'ram' ? 'ram' : 'disk') : null;
    const minMem = minMemFor(rootfs || 'ram');
    if (memRaw && (mem === null || mem < minMem || mem > L.maxMem)) {
      return showErr(err, 'Memory must be a number from ' + minMem + ' to ' + L.maxMem + ' MB' + (rootfs ? (rootfs === 'ram' ? ' for a RAM root' : ' for a disk root') : '') + ', or blank for automatic.', $('#csMem'));
    }
    if (rootfs && rootfs !== o.rootfs) body.rootfs = rootfs;
    if (cpuRaw && (cpus === null || cpus < 1 || cpus > L.maxCpus)) return showErr(err, 'vCPUs must be a number from 1 to ' + L.maxCpus + ', or blank.', $('#csCpu'));
    if (mem !== o.mem) body.mem = mem;
    if (cpus !== o.cpus) body.cpus = cpus;
    if ($('#csAuto').checked && $('#csRm').checked) return showErr(err, '"Start it with the manager" and "Remove the container when it exits" cannot both be on.', $('#csRm'));
    if ($('#csAuto').checked !== o.autostart) body.autostart = $('#csAuto').checked;
    if ($('#csRm').checked !== o.autoRemove) body.autoRemove = $('#csRm').checked;
    const p = CS.ports.read();
    if (p.error) return showErr(err, p.error);
    if (JSON.stringify(p.ports) !== JSON.stringify(o.ports)) body.ports = p.ports;
    if (Object.keys(body).length === 1) { hideErr(err); toast('Nothing to save - no setting was changed', 'ok'); return; }
    hideErr(err);
    // disk -> RAM drops the writable layer at the next start: say so first
    if (body.rootfs === 'ram' && !await confirmDialog('Switch "' + (o.name || id) + '" to a RAM root?',
      'At its next start the container\'s writable layer is deleted: every file it changed outside volumes and shared folders is lost, '
      + 'and from then on it resets at every start. It also needs more memory (about 2 x the image + 90 MB).', 'Switch to RAM')) return;
    if (id !== CTRD.id) return;
    const undo = busyButton(b);
    try {
      const r = await post('/api/container/settings', body);
      if (id !== CTRD.id) return;
      CS.dirty = false;
      const c = CTRS.get(id);
      setChildren($('#csStatus'), r.pendingRestart || (c && ctrLive(c)) ? 'Saved - memory, vCPUs, ports and the root filesystem apply the next time the container starts.' : 'Saved.',
        (Array.isArray(r.warnings) ? r.warnings : []).map((w) => h('div', null, 'Note: ' + w)));
      toast('Container settings saved', 'ok');
      await ctrdFetch(true);
      csFill(true);
      pokePoll(0);
    } catch (e) {
      if (!e.auth) showErr(err, notImpl(e) ? 'Container settings are not available in this version of the manager yet.' : e.message);
    } finally {
      undo();
    }
  }

  // ---- the Memory field shows the default (spec 12.2, SPEC-diskroot 7) ----
  // Disk root: the engine's fixed default (128 MB, 112 with the light
  // profile) whatever the image. RAM root: plan.recommendedMemMB, as the
  // manager computes it - the image lives in RAM: 2.2 x image + 90 MB while
  // booting (2 x was measured too little for a 600 MB image), image + 176 MB
  // running - and at least 256 MB
  function recommendedMemMB(bytes) {
    const mib = bytes / 1048576;
    return Math.max(256, Math.ceil(Math.max(2.2 * mib + 90, mib + 48 + 128, 128) / 16) * 16);
  }
  // "nginx:alpine" -> "docker.io/library/nginx:alpine" (how /api/images
  // names references)
  function canonRef(s) {
    let r = String(s || '').trim();
    if (!r) return '';
    let digest = '';
    const at = r.indexOf('@');
    if (at >= 0) { digest = r.slice(at); r = r.slice(0, at); }
    const slash = r.indexOf('/');
    const first = slash >= 0 ? r.slice(0, slash) : '';
    let registry = 'docker.io', repo = r;
    if (slash >= 0 && (/[.:]/.test(first) || first === 'localhost')) { registry = first === 'index.docker.io' ? 'docker.io' : first; repo = r.slice(slash + 1); }
    if (registry === 'docker.io' && repo.indexOf('/') === -1) repo = 'library/' + repo;
    if (!digest && repo.slice(repo.lastIndexOf('/') + 1).indexOf(':') === -1) repo += ':latest';
    return registry + '/' + repo + digest;
  }
  const MEMHINT = { data: null, at: 0, busy: false, timer: null };
  async function memHint() {
    const el = $('#qMem');
    // a disk root does not size its memory to the image
    if ($('#qRootfs').value !== 'ram') { el.placeholder = 'automatic: ' + mvDefaults().memMB + ' MB'; return; }
    const img = $('#qImg').value.trim();
    if (!img) { el.placeholder = 'automatic'; return; }
    if (!MEMHINT.data || Date.now() - MEMHINT.at > 30000) {
      if (MEMHINT.busy) return;
      MEMHINT.busy = true;
      try {
        MEMHINT.data = IMG.data && Date.now() - IMG.last < 30000 ? IMG.data : await api('/api/images');
        MEMHINT.at = Date.now();
      } catch (e) { MEMHINT.data = null; } finally { MEMHINT.busy = false; }
    }
    if ($('#qImg').value.trim() !== img || $('#qRootfs').value !== 'ram') return; // changed meanwhile: the next call decides
    const want = canonRef(img);
    const list = MEMHINT.data && Array.isArray(MEMHINT.data.images) ? MEMHINT.data.images : [];
    const row = list.find((x) => Array.isArray(x.references) && x.references.indexOf(want) !== -1);
    // the exact initrd size once it was built, else 3 x the download (the
    // manager's own estimate before the first run)
    const bytes = !row ? null : (Number.isFinite(row.initrdBytes) && row.initrdBytes > 0 ? row.initrdBytes
      : (Number.isFinite(row.compressedBytes) && row.compressedBytes > 0 ? 3 * row.compressedBytes : null));
    el.placeholder = bytes ? 'automatic (about ' + recommendedMemMB(bytes) + ' MB)' : 'automatic';
  }
  function memHintSoon() {
    clearTimeout(MEMHINT.timer);
    MEMHINT.timer = setTimeout(() => { memHint().catch(() => {}); }, 400);
  }

  // ===========================================================================
  // Images (the microVM engine's cache) - fetched only while the card is open
  // ===========================================================================
  const IMG = { busy: false, last: 0, data: null, key: '', na: false, err: null };
  async function loadImages(force) {
    if (!$('#imgDetails').open || document.hidden) return;
    if (IMG.busy || (!force && Date.now() - IMG.last < 15000)) return;
    IMG.busy = true;
    IMG.last = Date.now();
    try {
      IMG.data = await api('/api/images');
      IMG.na = false;
      IMG.err = null;
    } catch (e) {
      if (e.auth) return;
      IMG.na = notImpl(e);
      IMG.err = IMG.na ? null : e.message;
    } finally {
      IMG.busy = false;
    }
    renderImages();
  }
  function ctrNames(ids) {
    return (Array.isArray(ids) ? ids : (ids ? [ids] : [])).map((x) => {
      const id = typeof x === 'string' ? x : (x && x.id);
      const c = id ? CTRS.get(id) : null;
      return c ? c.name : (x && x.name) || id || '';
    }).filter(Boolean);
  }
  function renderImages() {
    const box = $('#imgList');
    const j = IMG.data || {};
    const list = Array.isArray(j.images) ? j.images : [];
    const key = JSON.stringify([list, j.rateLimit, j.cacheBytes, IMG.na, IMG.err, Array.from(CTRS.keys()), STATE && STATE.settings && STATE.settings.imagePruneDays]);
    if (key === IMG.key) return;
    IMG.key = key;
    $('#imgPrune').disabled = IMG.na;
    $('#imgPullGo').disabled = IMG.na;
    if (IMG.na) { setText($('#imgStatus'), ''); setChildren(box, h('div', { class: 'empty' }, 'The image cache is not available in this version of the manager yet.')); return; }
    if (IMG.err) { setChildren(box, h('div', { class: 'empty' }, 'Could not read the images: ' + IMG.err)); return; }
    const rl = j.rateLimit && typeof j.rateLimit === 'object' ? j.rateLimit : null;
    const pruneDays = STATE && STATE.settings && Number.isInteger(STATE.settings.imagePruneDays) ? STATE.settings.imagePruneDays : 0;
    setText($('#imgStatus'), [Number.isFinite(j.cacheBytes) ? 'Cache: ' + fmtBytes(j.cacheBytes) : null,
      rl && Number.isFinite(rl.remaining) ? 'Docker Hub pulls left: ' + rl.remaining + (Number.isFinite(rl.limit) ? ' of ' + rl.limit : '')
        + (Number.isFinite(rl.window) ? ' per ' + fmtDur(rl.window) : '') + (rl.at ? ' (as of ' + ago(rl.at) + ')' : '') : null,
      pruneDays ? 'Images unused for ' + pruneDays + ' days are pruned automatically' : null].filter(Boolean).join(' · '));
    if (!list.length) { setChildren(box, h('div', { class: 'empty' }, 'No images yet - they are downloaded the first time you run them, or pull one below.')); return; }
    keepFocusIn(box, () => setChildren(box, h('div', { class: 'tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Image', 'Download / unpacked / disk', 'Last used', 'Used by', 'Engine'].map((x) => h('th', { scope: 'col' }, x)),
        h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
      h('tbody', null, list.map((im, i) => imageRow(im, i)))))));
  }
  // the unpacked size: a RAM-root image has its rootfs archive size, a
  // disk-root one (the default) only its unpacked size (cov-1)
  function unpackedOf(im) {
    if (Number.isFinite(im.rootfsBytes)) return im.rootfsBytes;
    return Number.isFinite(im.unpackedBytes) ? im.unpackedBytes : null;
  }
  function imageRow(im, i) {
    const refs = (Array.isArray(im.references) ? im.references : []).map(String);
    const ref = refs[0] || '';
    const used = ctrNames(im.usedBy);
    const compat = im.compat && typeof im.compat === 'object' ? im.compat : null;
    const warns = (Array.isArray(im.warnings) ? im.warnings : []).map(errText).filter(Boolean);
    const reasons = compat && Array.isArray(compat.reasons) ? compat.reasons.map(errText).filter(Boolean) : [];
    return h('tr', null,
      h('td', null, refs.length ? refs.map((r) => h('div', { class: 'mono breakall' }, r)) : h('span', { class: 'mono' }, '(untagged)'),
        im.configDigest ? h('div', { class: 'small mono', title: im.configDigest }, String(im.configDigest).slice(0, 19) + '...') : null,
        warns.length ? h('div', { class: 'small', title: warns.join('\n') }, warns.length + ' warning' + (warns.length === 1 ? '' : 's') + ' when unpacked') : null,
        im.complete === false ? h('span', { class: 'tag warn', title: 'Some layers are not downloaded - Pull latest fetches them' }, 'incomplete') : null),
      // disk: the read-only image disk its disk-root containers share ("-" until one ran)
      h('td', { class: 'mono', title: 'download / unpacked / image disk (shared by its disk-root containers)' },
        fmtBytes(im.compressedBytes) + ' / ' + fmtBytes(unpackedOf(im)) + ' / ' + fmtBytes(Number.isFinite(im.diskBytes) ? im.diskBytes : null)),
      h('td', { class: 'mono' }, im.lastUsed ? ago(im.lastUsed) : (im.pulledAt ? 'never (pulled ' + ago(im.pulledAt) + ')' : 'never')),
      h('td', null, used.length ? used.join(', ') : h('span', { class: 'small' }, '-')),
      h('td', null, !compat ? '-' : (compat.engine === 'docker-vm'
        ? h('span', { class: 'tag warn', title: reasons.join('\n') || 'Needs Docker inside a VM' }, 'Docker VM')
        : h('span', { class: 'tag', title: reasons.join('\n') || null }, 'microVM'))),
      h('td', null, h('div', { class: 'btns' },
        ref && RE.image.test(ref) ? btn('Pull latest', 'sm', { fk: 'ipl' + i, aria: 'Pull the latest ' + ref, onClick: (b) => runTask('/api/image/pull', { image: ref }, { btn: b }) }) : null,
        btn('Remove', 'sm danger-outline', { fk: 'irm' + i, aria: 'Remove ' + (ref || 'this image'), onClick: (b) => removeImageCache(b, im, ref, used) }))));
  }
  async function removeImageCache(b, im, ref, used) {
    const what = ref || String(im.configDigest || '').slice(0, 19);
    if (!await confirmDialog('Remove the image "' + what + '"?',
      'Its files are deleted from the cache; running it again downloads it again.'
      + (used.length ? '\n\nIt is used by: ' + used.join(', ') + '. A container that already has its own writable layer keeps the image disk it '
        + 'needs until that container is removed; the others download the image again when they start.' : ''), 'Remove image')) return;
    const body = im.configDigest ? { configDigest: im.configDigest } : { image: ref };
    const undo = busyButton(b);
    try {
      try {
        await post('/api/image/remove', body);
      } catch (e) {
        if (e.code !== 'IMAGE_IN_USE') throw e;
        undo();
        if (!await confirmDialog('The image is still used', e.message + '\n\nRemove it anyway? The containers that use it keep their records; '
          + 'one with a writable layer keeps its image disk until it is removed, the others download the image again when they start.', 'Remove anyway')) return;
        await post('/api/image/remove', Object.assign({ force: true }, body));
      }
      toast('Removed ' + what, 'ok');
    } catch (e) {
      if (!e.auth) toast('Could not remove ' + what + ': ' + e.message, 'err');
    } finally {
      undo();
      loadImages(true);
    }
  }
  async function pruneImages(b) {
    if (!await confirmDialog('Prune unused images?',
      'Images that no container uses are deleted from the cache. They are downloaded again when you run them.', 'Prune')) return;
    runTask('/api/images/prune', {}, { btn: b });
  }
  function pullImageCache(b) {
    const image = $('#imgPullRef').value.trim();
    const why = imageProblem(image);
    if (why) { toast(why, 'err'); $('#imgPullRef').focus(); return; }
    runTask('/api/image/pull', { image: image }, { btn: b, onAccepted: () => { $('#imgPullRef').value = ''; } });
  }

  // ===========================================================================
  // Volumes (named, persistent; inside the Containers card)
  // ===========================================================================
  const VOL = { busy: false, last: 0, data: null, key: '', na: false, err: null };
  async function loadVolumes(force) {
    if (!$('#volDetails').open || document.hidden) return;
    if (VOL.busy || (!force && Date.now() - VOL.last < 15000)) return;
    VOL.busy = true;
    VOL.last = Date.now();
    try {
      VOL.data = await api('/api/volumes');
      VOL.na = false;
      VOL.err = null;
    } catch (e) {
      if (e.auth) return;
      VOL.na = notImpl(e);
      VOL.err = VOL.na ? null : e.message;
    } finally {
      VOL.busy = false;
    }
    renderVolumes();
  }
  function renderVolumes() {
    const box = $('#volList');
    const list = VOL.data && Array.isArray(VOL.data.volumes) ? VOL.data.volumes : [];
    const key = JSON.stringify([list, VOL.na, VOL.err, Array.from(CTRS.keys())]);
    if (key === VOL.key) return;
    VOL.key = key;
    $('#volCreate').disabled = VOL.na;
    if (VOL.na) { setChildren(box, h('div', { class: 'empty' }, 'Volumes are not available in this version of the manager yet.')); return; }
    if (VOL.err) { setChildren(box, h('div', { class: 'empty' }, 'Could not read the volumes: ' + VOL.err)); return; }
    if (!list.length) { setChildren(box, h('div', { class: 'empty' }, 'No volumes yet. A volume named in a run (e.g. pgdata:/var/lib/postgresql/data) is created automatically.')); return; }
    keepFocusIn(box, () => setChildren(box, h('div', { class: 'tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Volume', 'Size (on disk / maximum)', 'Used by', 'Created'].map((x) => h('th', { scope: 'col' }, x)),
        h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
      h('tbody', null, list.filter((v) => v && typeof v.name === 'string').map((v) => {
        const used = ctrNames(v.usedBy);
        return h('tr', null,
          h('td', null, h('b', null, v.name)),
          h('td', { class: 'mono' }, fmtBytes(v.fileBytes) + ' / ' + fmtBytes(v.virtualBytes)),
          h('td', null, used.length ? used.join(', ') : h('span', { class: 'small' }, '-')),
          h('td', { class: 'mono' }, v.createdAt ? fmtDate(v.createdAt) : '-'),
          h('td', null, btn('Remove', 'sm danger-outline', { fk: 'vrm:' + v.name, aria: 'Remove the volume ' + v.name, onClick: (b) => removeVolume(b, v.name, used) })));
      }))))));
  }
  async function createVolume(b) {
    const err = $('#volErr');
    const name = $('#volName').value.trim();
    const sizeRaw = $('#volSize').value.trim();
    if (!RE_VOLUME.test(name)) return showErr(err, 'Volume name: 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit.', $('#volName'));
    const size = sizeRaw ? toInt(sizeRaw) : undefined;
    if (size !== undefined && (size === null || size < 1 || size > 2048)) return showErr(err, 'Size: a number of GB from 1 to 2048, or blank for the default (8 GB).', $('#volSize'));
    hideErr(err);
    const undo = busyButton(b);
    try {
      const body = { name: name };
      if (size !== undefined) body.sizeGB = size;
      await post('/api/volume/create', body);
      $('#volName').value = '';
      $('#volSize').value = '';
      toast('Created the volume "' + name + '"', 'ok');
      loadVolumes(true);
    } catch (e) {
      if (!e.auth) showErr(err, notImpl(e) ? 'Volumes are not available in this version of the manager yet.' : e.message);
    } finally {
      undo();
    }
  }
  async function removeVolume(b, name, used) {
    if (!await confirmDialog('Remove the volume "' + name + '"?',
      'Everything stored in it is deleted permanently.' + (used.length ? '\n\nContainers set up to use it: ' + used.join(', ') + '. A new, empty volume is made if they start again.' : ''), 'Remove volume')) return;
    const undo = busyButton(b);
    try {
      await post('/api/volume/remove', { name: name });
      toast('Removed the volume "' + name + '"', 'ok');
    } catch (e) {
      if (!e.auth) toast('Could not remove "' + name + '": ' + e.message, 'err');
    } finally {
      undo();
      loadVolumes(true);
    }
  }
  // the open image and volume lists refresh now and then (other tools -
  // Claude, a second tab - change them too)
  setInterval(() => {
    if (document.hidden || AUTH_NEEDED) return;
    loadImages(false);
    loadVolumes(false);
  }, 15000);

  // ===========================================================================
  // global settings (gear): acceleration, default exposure, data folder, MCP
  // ===========================================================================
  let ABOUT = null;
  async function openSettingsDialog() {
    if (!STATE) { toast('Still connecting to the manager', 'err'); return; }
    if (!ABOUT) { try { ABOUT = await api('/api/about'); } catch (e) { if (e.auth) return; ABOUT = null; } }
    const s = STATE.settings || {};
    const a = (STATE.platform && STATE.platform.accel) || {};
    const opts = ['auto'].concat(a.available && a.available.length ? a.available : ['tcg']);
    if (s.accel && opts.indexOf(s.accel) === -1) opts.push(s.accel);
    const accelSel = h('select', { id: 'gAccel', name: 'accel' }, opts.map((o) => h('option', { value: o },
      o === 'auto' ? 'Automatic - use the fastest one this PC supports' + (a.recommended ? ' (' + a.recommended.toUpperCase() + ')' : '') : accelName(o))));
    accelSel.value = s.accel || 'auto';
    const lan = s.defaultExpose === 'lan';
    const radios = h('fieldset', { class: 'radios' }, h('legend', null, 'New port forwards are reachable from'),
      h('label', { class: 'chk' }, h('input', { type: 'radio', name: 'defaultExpose', value: 'local', checked: !lan }), 'This PC only (recommended)'),
      h('label', { class: 'chk' }, h('input', { type: 'radio', name: 'defaultExpose', value: 'lan', checked: lan }), 'Other devices on my network too (LAN)'));
    const dataRoot = h('input', { id: 'gData', readonly: true, spellcheck: 'false' });
    dataRoot.value = STATE.dataRoot || (ABOUT && ABOUT.dataRoot) || '';
    const ah = STATE.accelHint && typeof STATE.accelHint === 'object' ? STATE.accelHint : null;
    // engine settings (config.json) - only from a manager that reports them
    const eng = typeof s.lightProfile === 'boolean' ? engineSections(s) : null;

    const sections = [
      h('div', { class: 'msec' }, h('h3', null, 'Acceleration'), field('gAccel', 'Accelerator for VMs set to Automatic', accelSel),
        h('div', { class: 'hint' }, a.detecting ? 'Still checking what this PC supports...'
          : 'Detected on this PC: ' + ((a.available || []).map(accelName).join(', ') || 'nothing yet (QEMU is not installed)')
          + '. Hardware acceleration is much faster; TCG always works. A VM can override this in its Settings tab.'),
        ah ? h('details', { class: 'mt', open: true }, h('summary', null, 'No hardware acceleration - how to turn it on'), accelHintNodes(ah)) : null),
      eng ? eng.nodes : null,
      h('div', { class: 'msec' }, h('h3', null, 'Port forwards'), radios,
        h('div', { class: 'hint' }, 'Only the default for forwards added from now on. Every forward keeps its own "Reachable from LAN" choice, which you can change any time.')),
      h('div', { class: 'msec' }, h('h3', null, 'Data folder'), field('gData', 'VMs, templates, logs, the SSH key and the access token live in', dataRoot),
        h('div', { class: 'hint' }, 'To use another folder, start the manager with --data "<folder>" or set the environment variable VM_MANAGER_ROOT.')),
      mcpSection(),
    ];
    openModal({
      title: 'Settings', wide: true, content: sections, submitLabel: 'Save',
      onSubmit: async (d) => {
        const body = eng ? eng.read(d) : {}; // throws a readable error: the dialog stays open
        if (d.accel && d.accel !== (s.accel || 'auto')) body.accel = d.accel;
        if (d.defaultExpose && d.defaultExpose !== (s.defaultExpose || 'local')) body.defaultExpose = d.defaultExpose;
        if (!Object.keys(body).length) return true;
        const r = await post('/api/settings', body);
        if (STATE) STATE.settings = r.settings;
        toast('Settings saved', 'ok');
        pokePoll(0);
        return true;
      },
    });
  }
  // ---- engine settings and the light profile (SPEC-diskroot 9, 10) ----
  // They live in the data folder's config.json; a field left blank means "the
  // profile's default" (an explicit value always beats the profile). The
  // manager checks every value again; ranges come from it (settings.ranges).
  const LP_ROWS = [
    // [config.json key, label, how a value reads]
    ['microvmMemMB', 'Container memory (disk root)', (v) => v + ' MB'],
    ['tcgTbSizeMB', 'Translation cache of a container without acceleration (TCG)', (v) => (v ? v + ' MB' : 'QEMU default')],
    ['vmTcgTbSizeMB', 'Translation cache of a full VM without acceleration (TCG)', (v) => (v ? v + ' MB' : 'QEMU default (1 GB)')],
    ['vmDefaultMemMB', 'Memory of a new full VM', (v) => v + ' MB'],
    ['keepAlpineDownload', 'Keep the Alpine download after the base image is built', (v) => (v ? 'kept' : 'deleted (downloaded again to rebuild)')],
    ['imagePruneDays', 'Remove images no container used for', (v) => (v ? v + ' days' : 'never')],
  ];
  const LP_FALLBACK = {
    normal: { microvmRootfs: 'disk', microvmMemMB: 128, tcgTbSizeMB: 128, vmTcgTbSizeMB: 0, vmDefaultMemMB: 1024, keepAlpineDownload: true, imagePruneDays: 0 },
    light: { microvmRootfs: 'disk', microvmMemMB: 112, tcgTbSizeMB: 64, vmTcgTbSizeMB: 256, vmDefaultMemMB: 512, keepAlpineDownload: false, imagePruneDays: 7 },
  };
  // s: STATE.settings -> {nodes, read(formData) -> request body (throws)}
  function engineSections(s) {
    const pd = s.profileDefaults && s.profileDefaults.normal && s.profileDefaults.light ? s.profileDefaults : LP_FALLBACK;
    const explicit = Array.isArray(s.explicit) ? s.explicit : [];
    const isSet = (k) => explicit.indexOf(k) !== -1;
    const ranges = s.ranges && typeof s.ranges === 'object' ? s.ranges : {};
    const light = h('input', { type: 'checkbox', id: 'gLight', name: 'lightProfile', checked: !!s.lightProfile });
    const prof = () => (light.checked ? pd.light : pd.normal);
    // microVM containers: default root filesystem and memory
    const rootSel = h('select', { id: 'gRootfs', name: 'microvmRootfs' },
      h('option', { value: 'disk' }, 'Disk - the image stays on disk, about 128 MB of RAM whatever its size (recommended)'),
      h('option', { value: 'ram' }, 'RAM - the whole image in memory, resets at every start'));
    rootSel.value = s.microvmRootfs === 'ram' ? 'ram' : 'disk';
    const num = (k, id) => {
      const el = h('input', { id: id, name: k, type: 'number', inputmode: 'numeric', step: '1' });
      if (isSet(k) && Number.isFinite(s[k])) el.value = String(s[k]);
      const r = ranges[k];
      if (r) { el.min = r.zeroOr ? 0 : r.min; el.max = r.max; }
      return el;
    };
    const mvMem = num('microvmMemMB', 'gMvMem');
    // the advanced values, each blank = the profile's default
    const adv = {
      tcgTbSizeMB: num('tcgTbSizeMB', 'gTcgTb'), vmTcgTbSizeMB: num('vmTcgTbSizeMB', 'gVmTcgTb'),
      vmDefaultMemMB: num('vmDefaultMemMB', 'gVmMem'), imagePruneDays: num('imagePruneDays', 'gPrune'),
    };
    const keepSel = h('select', { id: 'gKeepAlpine', name: 'keepAlpineDownload' },
      h('option', { value: '' }, 'the profile\'s default'), h('option', { value: 'true' }, 'keep it'), h('option', { value: 'false' }, 'delete it'));
    keepSel.value = isSet('keepAlpineDownload') ? String(!!s.keepAlpineDownload) : '';
    // the table of what the profile changes, refreshed when the box is ticked
    const tbody = h('tbody');
    const placeholders = () => {
      const p = prof();
      mvMem.placeholder = 'profile default: ' + p.microvmMemMB + ' MB';
      for (const k of Object.keys(adv)) adv[k].placeholder = 'profile default: ' + (LP_ROWS.find((r) => r[0] === k)[2])(p[k]);
      setChildren(tbody, LP_ROWS.map((r) => h('tr', null, h('td', null, r[1]), h('td', { class: 'mono' }, r[2](pd.normal[r[0]])), h('td', { class: 'mono' }, r[2](pd.light[r[0]])),
        h('td', { class: 'mono' }, isSet(r[0]) ? r[2](s[r[0]]) + ' (set by you)' : r[2](p[r[0]])))));
    };
    light.addEventListener('change', placeholders);
    placeholders();
    const nodes = [
      h('div', { class: 'msec' }, h('h3', null, 'microVM containers'),
        h('div', { class: 'grid g-2' }, field('gRootfs', 'Default root filesystem', rootSel), field('gMvMem', 'Default memory of a disk-root container (MB)', mvMem)),
        h('div', { class: 'hint' }, 'Disk is lighter in every way: the image is written once to a read-only disk shared by its containers, '
          + 'so a container needs about 128 MB whatever the image size, and its own changes are kept until it is removed. RAM holds the whole '
          + 'image in memory and resets at every start. A container can pick its own under Run > Advanced. Memory below 128 MB suits small apps only '
          + '(a container short of memory slows to a crawl). Blank memory = the profile\'s default.')),
      h('div', { class: 'msec' }, h('h3', null, 'Light profile'),
        h('label', { class: 'chk' }, light, 'Use the light profile - smaller defaults so the manager fits inside another VM or a small PC'),
        h('div', { class: 'hint' }, 'It changes defaults only; a value you set yourself below always wins. New VMs and containers get the new '
          + 'defaults at their next start.'),
        h('div', { class: 'tablewrap mt' }, h('table', { class: 'lptable' },
          h('thead', null, h('tr', null, ['Setting', 'Normal', 'Light', 'Now'].map((x) => h('th', { scope: 'col' }, x)))), tbody)),
        h('details', { class: 'mt' }, h('summary', null, 'Set single values (blank = the profile\'s default)'),
          h('div', { class: 'grid g-2 mt' },
            field('gTcgTb', 'Container TCG translation cache (MB, 0 = QEMU default)', adv.tcgTbSizeMB),
            field('gVmTcgTb', 'Full-VM TCG translation cache (MB, 0 = QEMU default)', adv.vmTcgTbSizeMB),
            field('gVmMem', 'Memory of a new full VM (MB)', adv.vmDefaultMemMB),
            field('gPrune', 'Remove unused images after (days, 0 = never)', adv.imagePruneDays),
            field('gKeepAlpine', 'The Alpine download after the base build', keepSel)),
          h('div', { class: 'hint' }, 'The translation cache only matters without hardware acceleration: smaller saves memory (64 MB instead of 128 '
            + 'saves about 84 MB per container) and costs some speed. These are saved in config.json in the data folder.'))),
    ];
    function read(d) {
      const body = {};
      if (!!d.lightProfile !== !!s.lightProfile) body.lightProfile = !!d.lightProfile;
      // the default root filesystem: both profiles say disk, so only a
      // change (or undoing an explicit RAM) is sent
      if (d.microvmRootfs && d.microvmRootfs !== (s.microvmRootfs || 'disk')) body.microvmRootfs = d.microvmRootfs;
      for (const r of LP_ROWS) {
        const k = r[0];
        if (k === 'keepAlpineDownload') {
          const v = d[k] === 'true' ? true : (d[k] === 'false' ? false : null);
          if (v === null) { if (isSet(k)) body[k] = null; } else if (!isSet(k) || v !== s[k]) body[k] = v;
          continue;
        }
        const raw = String(d[k] === undefined ? '' : d[k]).trim();
        if (!raw) { if (isSet(k)) body[k] = null; continue; }
        const n = toInt(raw), rg = ranges[k];
        const ok = n !== null && (!rg || (rg.zeroOr && n === 0) || (n >= rg.min && n <= rg.max));
        if (!ok) throw new Error(r[1] + ': a whole number' + (rg ? (rg.zeroOr ? ', 0 or ' : ' from ') + rg.min + ' to ' + rg.max : '') + ', or blank for the profile\'s default.');
        if (!isSet(k) || n !== s[k]) body[k] = n;
      }
      return body;
    }
    return { nodes: nodes, read: read };
  }
  function mcpSection() {
    const sec = h('div', { class: 'msec' }, h('h3', null, 'Connect Claude (MCP)'),
      h('div', { class: 'hint nomargin mb' }, 'Lets Claude create VMs on demand and run commands, tests and deployments inside them - '
        + 'isolated from this PC. Temporary VMs it creates are marked "temporary" and "Claude" in the list.'));
    if (!ABOUT || !ABOUT.mcpConfig) {
      sec.appendChild(h('div', { class: 'field-error' }, 'Could not read the MCP settings from the manager.'));
      return sec;
    }
    const json = JSON.stringify(ABOUT.mcpConfig, null, 2);
    const srv = ABOUT.mcpConfig.mcpServers && ABOUT.mcpConfig.mcpServers['devbox-vms'];
    if (ABOUT.mcpServerExists === false) {
      sec.appendChild(h('div', { class: 'field-error' }, 'mcp-server.js is missing from this copy of the manager, so this will not work yet.'));
    }
    sec.appendChild(h('div', { class: 'hint nomargin' }, 'Claude Desktop: Settings > Developer > Edit Config, merge this into claude_desktop_config.json, then restart Claude. '
      + 'Claude Code: put it in a project\'s .mcp.json, or run the command below.'));
    sec.appendChild(h('div', { class: 'copyrow mt' }, h('pre', { tabindex: '0', 'aria-label': 'MCP configuration' }, json),
      btn('Copy', 'sm', { aria: 'Copy the MCP configuration', onClick: () => copyText(json, 'the MCP configuration') })));
    if (srv && srv.command && Array.isArray(srv.args) && srv.args.length) {
      const q = (x) => '"' + String(x).replace(/"/g, '\\"') + '"';
      const envs = Object.keys(srv.env || {}).map((k) => '-e ' + k + '=' + q(srv.env[k])).join(' ');
      const cmd = 'claude mcp add devbox-vms ' + (envs ? envs + ' ' : '') + '-- ' + q(srv.command) + ' ' + srv.args.map(q).join(' ');
      sec.appendChild(h('div', { class: 'copyrow mt' }, h('pre', { tabindex: '0', 'aria-label': 'Claude Code command' }, cmd),
        btn('Copy', 'sm', { aria: 'Copy the Claude Code command', onClick: () => copyText(cmd, 'the command') })));
    }
    return sec;
  }

  // ===========================================================================
  // deep links: /?vm=<name>&tab=<tab>  (and the v1 form /?console=<name>)
  // ===========================================================================
  function openDeepLink() {
    let q;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }
    // /?container=<id or name>[&tab=logs]
    const ctr = q.get('container');
    if (ctr) {
      const c = CTRS.get(ctr) || Array.from(CTRS.values()).find((x) => x.name === ctr);
      if (c) { selectCtr(c.id, CTABS.indexOf(q.get('tab')) !== -1 ? q.get('tab') : undefined); return; }
    }
    const vm = q.get('vm') || q.get('console');
    if (!vm || !VMS.has(vm)) return;
    const tab = q.get('console') ? 'terminal' : q.get('tab');
    selectVm(vm, TABS.indexOf(tab) !== -1 ? tab : undefined);
  }

  // ===========================================================================
  // wiring
  // ===========================================================================
  function on(sel, ev, fn) { $(sel).addEventListener(ev, fn); }
  // handlers get the element that was clicked (captured before any await)
  function onClick(sel, fn) { on(sel, 'click', (e) => fn(e.currentTarget)); }

  function wire() {
    on('#authForm', 'submit', submitToken);
    onClick('#btnRefresh', () => {
      pokePoll(0);
      if (TAB === 'docker') loadDocker(true);
      if (TAB === 'network') loadNetwork(true);
    });
    onClick('#btnSettings', openSettingsDialog);
    onClick('#accelHow', showAccelHint);
    onClick('#btnSetup', (b) => ctaClick(b, 'primary'));
    onClick('#btnSetup2', (b) => ctaClick(b, 'secondary'));
    onClick('#btnClearTasks', () => { for (const t of TASKS.recent) TASKS.hidden.add(t.id); renderTasks(); });
    onClick('#btnCleanTemp', deleteTempVms);
    onClick('#nwGo', createVm);
    on('#nwName', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#nwGo').click(); } });
    onClick('#apGo', createAppliance);
    on('#apSource', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#apGo').click(); } });

    // remember which defaults the user has overridden (never overwrite those)
    const touch = (e) => { if (e.target && e.target.dataset) e.target.dataset.touched = '1'; };
    document.addEventListener('input', touch, true);
    document.addEventListener('change', touch, true);

    // detail panel
    onClick('#dClose', closeDetail);
    for (const b of $$('#dTabs [role=tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));
    on('#dTabs', 'keydown', onTabKey);
    onClick('#ovStart', (b) => runTask('/api/vm/start', { name: CURRENT }, { btn: b }));
    onClick('#ovStop', (b) => runTask('/api/vm/stop', { name: CURRENT }, { btn: b }));
    onClick('#ovRestart', (b) => runTask('/api/vm/restart', { name: CURRENT }, { btn: b }));
    onClick('#ovForce', forceStop);
    onClick('#ovTerminal', () => {
      if (isAppliance(VMS.get(CURRENT))) { showTab('screen'); return; }
      showTab('terminal'); if (!sshView.live()) sshView.connect(CURRENT);
    });
    onClick('#ovEject', async (b) => {
      if (!await confirmDialog('Remove the installation media of "' + CURRENT + '"?', 'The installer (ISO or image) is detached; the VM boots from its own disk from now on. Do this once the OS is installed.', 'Remove media')) return;
      runTask('/api/vm/eject', { name: CURRENT }, { btn: b });
    });
    onClick('#ovCopySsh', () => { const v = VMS.get(CURRENT); if (v && v.sshCommand) copyText(v.sshCommand, 'the SSH command'); });
    onClick('#ovDisplay', (b) => {
      const v = VMS.get(CURRENT);
      if (v && isAppliance(v)) switchDisplay(v, v.appliance && v.appliance.display === 'window' ? 'browser' : 'window', b);
    });
    onClick('#ovForget', () => forgetVm(CURRENT));
    onClick('#sSave', saveSettings);
    onClick('#sRestartNow', (b) => runTask('/api/vm/restart', { name: CURRENT }, { btn: b }));
    onClick('#pAdd', addPortRow);
    onClick('#pSave', savePorts);
    onClick('#pUndo', () => { const v = VMS.get(CURRENT); hideErr($('#pErr')); setText($('#pStatus'), ''); fillPorts((v && v.ports) || [], true); });
    onClick('#dkResize', resizeDisk);
    onClick('#dkGrow', (b) => runTask('/api/vm/growfs', { name: CURRENT }, { btn: b }));
    onClick('#dkCompact', (b) => runTask('/api/vm/compact', { name: CURRENT }, { btn: b }));
    onClick('#snapCreate', createSnapshot);
    onClick('#fzGo', freezeVm);
    onClick('#vReset', resetVm);
    onClick('#vDelete', deleteVm);

    // docker
    onClick('#dockRefresh', () => loadDocker(true));
    fillPresetSelect($('#dpPreset'));
    on('#dpPreset', 'change', onDeployPreset);
    onClick('#dpGo', deployImage);
    onClick('#dpInspect', inspectImage);
    onClick('#rnGo', runContainer);
    onClick('#plGo', pullImage);
    onClick('#cpLoad', loadComposeFile);
    onClick('#cpGo', deployCompose);

    // network
    onClick('#netRefresh', () => loadNetwork(true));
    on('#netOnlyVm', 'change', () => { NET.key = ''; renderNetwork(); });

    // terminals
    sshView = new TermView({ kind: 'ssh', mount: '#tTerm', status: '#tStatus', connect: '#tConnect', disconnect: '#tDisconnect', user: '#tUser', cmd: '#tCmd' });
    serialView = new TermView({ kind: 'serial', mount: '#scTerm', status: '#scStatus', connect: '#scConnect', disconnect: '#scDisconnect' });
    onClick('#scLogToggle', toggleLogView);
    onClick('#scLogDownload', downloadLog);
    screenView = new ScreenView();
    window.addEventListener('pagehide', () => { sshView.abandon(); serialView.abandon(); screenView.disconnect(true); clogStop(); });

    // shared folders (VM settings)
    onClick('#shBrowse', () => browseInto($('#shHost')));
    onClick('#shAdd', addShare);
    setText($('#shCaveat'), SHARE_CAVEAT + ' ' + SHARE_ACCESS);

    // run a Docker image
    RUN.ports = portEditor($('#qPortRows'), { fk: 'qp', empty: 'No rows - the ports the image declares are used.' });
    RUN.env = envEditor($('#qEnvRows'), { fk: 'qe', empty: 'No variables - the image\'s own defaults apply.' });
    RUN.vols = volEditor($('#qVolRows'), { fk: 'qv', empty: 'No volumes or folders - files the app writes stay in the container until it is removed (with a RAM root: until it stops).', emptyVm: 'No volumes.' });
    RUN.ports.render();
    RUN.env.render();
    RUN.vols.render();
    fillPresetSelect($('#qPreset'));
    on('#qPreset', 'change', onQuickPreset);
    onClick('#qGo', runImage);
    on('#qImg', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#qGo').click(); } });
    on('#qImg', 'input', memHintSoon);
    on('#qMore', 'toggle', () => { if ($('#qMore').open) memHintSoon(); });
    onClick('#qPortAdd', () => RUN.ports.add());
    onClick('#qEnvAdd', () => RUN.env.add());
    onClick('#qVolAdd', () => RUN.vols.add());
    for (const id of ['#qEngine', '#qPriv', '#qHostNet']) on(id, 'change', onRunEngineChange);
    onRunEngineChange();
    on('#qRootfs', 'change', onRootfsChange);
    onRootfsChange();

    // containers
    onClick('#btnCleanCtr', deleteTempCtrs);
    onClick('#cdClose', closeCtrDetail);
    for (const b of $$('#cdTabs [role=tab]')) b.addEventListener('click', () => showCtab(b.dataset.tab));
    on('#cdTabs', 'keydown', onCtabKey);
    on('#clStream', 'change', clogLoad);
    on('#clFollow', 'change', clogLoad);
    on('#clPrev', 'change', clogLoad);
    onClick('#clRefresh', clogLoad);
    onClick('#clDownload', clogDownload);
    CS.ports = portEditor($('#csPortRows'), { fk: 'csp', empty: 'No published ports.', onChange: csDirty });
    CS.ports.render();
    on('#cp-settings', 'input', (e) => { if (e.target && e.target.id && /^cs/.test(e.target.id)) csDirty(); });
    on('#cp-settings', 'change', (e) => { if (e.target && e.target.id && /^cs/.test(e.target.id)) csDirty(); });
    on('#csRootfs', 'change', csRootfsHint);
    onClick('#csSave', csSave);
    onClick('#csUndo', () => { hideErr($('#csErr')); setText($('#csStatus'), ''); csFill(true); });
    on('#volDetails', 'toggle', () => loadVolumes(true));
    onClick('#volCreate', createVolume);
    on('#volName', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#volCreate').click(); } });

    // images
    on('#imgDetails', 'toggle', () => loadImages(true));
    onClick('#imgRefresh', () => loadImages(true));
    onClick('#imgPrune', pruneImages);
    onClick('#imgPullGo', pullImageCache);
    on('#imgPullRef', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#imgPullGo').click(); } });
  }

  // ===========================================================================
  // start
  // ===========================================================================
  TOKEN = initToken();
  wire();
  poll();
})();
