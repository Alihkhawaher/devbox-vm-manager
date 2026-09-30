'use strict';
/*
 * MCP tools for LIVE shared folders (SPEC-shares.md section 7): a folder of
 * this PC mounted inside a VM, the same files on both sides - no upload /
 * download round trips while Claude works on a project the user edits.
 *
 *   share_folder     {vm, host_path, guest_path, read_only}  add (live on a
 *                    running VM, else at its next start) -> mount status
 *   unshare_folder   {vm, guest_path}                         remove
 *   list_shares      {vm | container}                         config + live status
 *
 * How it works (lib/shares.js): the manager runs its own 9P2000.L file
 * server on the host's 127.0.0.1; the guest mounts it over its user-mode
 * network (10.0.2.2) with a per-share secret. The Windows QEMU build has no
 * 9p or virtio-fs, and this way works with every QEMU on every host OS.
 * microVM containers get the same thing through a host folder in
 * run_image's volumes.
 *
 * A shared folder is a two-way door: whatever runs in the guest can read it
 * and - unless it is read-only - write it. So host_path passes the same
 * guard as upload/download (tools.guardLocalPath), as a WRITE target for a
 * read-write share and a read source for a read-only one, with folder rules
 * (a folder that contains ~/.ssh or the manager's data folder is refused
 * too). The manager refuses its data folder and system folders on its own.
 *
 * The builders get createTools' helpers as a bag (h), like
 * lib/mcp/containers.js. Requiring this module has no side effects.
 */
const fs = require('fs');
const { ToolError } = require('./protocol');

// SPEC-shares.md section 8: the one caveat text, used in the GUI hint, the
// README and here, so the model tells the user the same thing.
const CAVEAT = 'Edits you make on Windows appear in the VM within a few tens of milliseconds, and files written in the VM are saved on ' +
  'Windows immediately. Changes made on Windows do not raise file-watch (inotify) events inside the VM, so dev servers that watch files ' +
  'need polling mode (e.g. CHOKIDAR_USEPOLLING=1, WATCHPACK_POLLING=true, vite server.watch.usePolling). Execute bits set with chmod +x ' +
  'are not stored (scripts and binaries are detected automatically); symlinks must stay inside the shared folder.';
// What a share's access means inside the guest (lib/shares.js ACCESS_NOTE;
// sec-6): the credential is visible to every program there.
const ACCESS_NOTE = 'Every program in the VM or container can use the WHOLE shared folder with the share\'s access (read-write unless the share is ' +
  'read-only) - also a Docker container inside a VM that only sees a sub-folder or mounts it ":ro": those do not limit it. Share only folders ' +
  'the guest may change, and make the share read-only when it should not.';

const { mb } = require('./containers');
const enc = encodeURIComponent;
// Adding a share to a running VM may install the guest service over SSH
// first (base images baked before shares existed): allow for it.
const SHARE_CALL_MS = 180000;

// ---------------------------------------------------------------------------
// pure helpers (exported for the tests)
// ---------------------------------------------------------------------------
// The mount point in the guest: a plain absolute POSIX path. The manager
// checks the rest (no /, /proc, /etc, ... - ninep/guest.validateGuestPath).
function checkGuestPath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new ToolError('guest_path is required');
  if (/[\0\r\n]/.test(p)) throw new ToolError('guest_path must not contain newlines or NUL characters');
  if (p.charAt(0) !== '/') throw new ToolError('guest_path must be an absolute path inside the VM, e.g. /root/project (got "' + p + '")');
  if (/\\/.test(p)) throw new ToolError('guest_path is a Linux path: use / not \\ (got "' + p + '")');
  const norm = p.replace(/\/+$/, '');
  if (!norm) throw new ToolError('guest_path cannot be / - use a folder such as /root/project');
  return norm;
}

// Same folder? (Windows paths compare case-insensitively, either slash)
function samePath(a, b, platformName) {
  if (!a || !b) return false;
  const win = (platformName || process.platform) === 'win32';
  const n = (p) => { let s = String(p).replace(/\\/g, '/').replace(/\/+$/, ''); if (win) s = s.toLowerCase(); return s; };
  return n(a) === n(b);
}

// One share from /api/shares (or a vm record's public shares[]) -> what the
// model sees. GET /api/shares rows carry the live fields flat plus a
// status word (mounted | pending | not-mounted | stopped | unavailable);
// a nested status object is read too. No secrets ever reach this point
// (the API never returns them).
function summarizeShare(s) {
  s = s || {};
  const st = s.status && typeof s.status === 'object' ? s.status : s;
  const o = { host_path: s.hostPath, guest_path: s.guestPath, read_only: !!s.readOnly };
  if (typeof s.status === 'string') o.state = s.status;
  if (typeof st.mounted === 'boolean') o.mounted = st.mounted;
  if (typeof st.connections === 'number') o.connections = st.connections;
  if (typeof st.openFiles === 'number') o.open_files = st.openFiles;
  if (typeof st.bytesRead === 'number') o.read_mb = mb(st.bytesRead);
  if (typeof st.bytesWritten === 'number') o.written_mb = mb(st.bytesWritten);
  if (typeof st.errors === 'number' && st.errors) o.errors = st.errors;
  const closes = Array.isArray(st.recentCloses) ? st.recentCloses : [];
  const last = st.lastClose || closes[closes.length - 1];
  if (last) o.last_disconnect = typeof last === 'string' ? last : (last.reason || last.why || JSON.stringify(last).slice(0, 200));
  if (s.error || st.lastError) o.error = String(s.error || st.lastError);
  return o;
}

// ---------------------------------------------------------------------------
// the tools
// ---------------------------------------------------------------------------
// h: {deps, conn, api, apiFail, waitTask, taskOutcome, findVm, guard,
//     checkLocalPath, getContainerId(c, ref), RO, ann}
function shareTools(h) {
  const RO = h.RO, ann = h.ann;
  const vmP = { type: 'string', required: true, minLength: 1, description: 'Name of the VM (as returned by create_vm / list_vms).' };
  const guestP = (what) => ({ type: 'string', required: true, minLength: 1, description: what });
  const tools = [];

  // Live status of one owner's shares -> {shares, problem, running}, or null
  // when the manager cannot say (an older one).
  async function sharesOf(c, owner) {
    let r;
    try { r = await c.get('/api/shares?owner=' + enc(owner)); }
    catch (e) {
      if (e && (e.status === 501 || e.status === 404)) return null;
      throw h.apiFail(e);
    }
    return { shares: (r && r.shares) || [], problem: (r && r.problem) || null, running: r ? r.running : undefined };
  }
  // POST /api/vm/shares: a direct reply, or a task (a live mount over SSH)
  async function sharesAction(c, body, what) {
    let r;
    try { r = await c.post('/api/vm/shares', body, SHARE_CALL_MS); }
    catch (e) { throw h.apiFail(e); }
    if (r && r.task && r.task.id && r.task.status === 'running') {
      const out = h.taskOutcome(await h.waitTask(c, r.task.id, SHARE_CALL_MS), what, SHARE_CALL_MS / 1000);
      if (out.status !== 'done') return { taskRunning: out };
      return Object.assign({ task_id: out.task_id }, out.result || {});
    }
    return r || {};
  }

  // ------------------------------------------------------------ share_folder
  tools.push({
    name: 'share_folder',
    title: 'Share a folder of this PC with a VM (live)',
    description: 'Share a folder of this PC LIVE with a VM: it appears at guest_path inside the VM and both sides see the same files (no ' +
      'copying - use it instead of upload/download round trips when working on a project folder the user also edits). ' + CAVEAT + ' ' +
      ACCESS_NOTE + ' On a running VM it is mounted at once; a stopped VM mounts it when it starts, and it is mounted again at every boot until ' +
      'unshare_folder removes it. Returns whether it is mounted. read_only=true when the VM only needs to read (the guest can otherwise ' +
      'change and delete files there). host_path must be an absolute folder on this PC; the VM manager\'s data folder, ~/.ssh, the manager\'s ' +
      'program folder, system folders and folders containing one of them cannot be shared. Share only folders the user named or agreed to. ' +
      'For a Docker image run with run_image, put the folder in its volumes instead ("C:\\Users\\me\\project:/app").',
    params: {
      vm: vmP,
      host_path: { type: 'string', required: true, minLength: 1, description: 'Absolute path of the folder on this PC, e.g. C:\\Users\\me\\project.' },
      guest_path: guestP('Where the folder appears inside the VM (absolute Linux path, e.g. /root/project); created if needed.'),
      read_only: { type: 'boolean', default: false, description: 'true = the VM can read but not change the folder.' },
    },
    annotations: ann({ idempotentHint: true }),
    handler: async (a) => {
      const host = h.checkLocalPath(a.host_path, 'host_path');
      let st = null;
      try { st = fs.statSync(host); } catch (e) { /* reported below */ }
      if (!st) throw new ToolError('host_path does not exist: ' + host);
      if (!st.isDirectory()) throw new ToolError('host_path is a file, not a folder: ' + host + ' - share its folder, or copy the file with upload');
      h.guard(host, 'host_path', a.read_only ? 'read' : 'write', true);
      const guest = checkGuestPath(a.guest_path);
      const c = await h.conn();
      const { vm } = await h.findVm(c, a.vm);
      const had = (vm.shares || []).find((s) => s.guestPath === guest);
      if (had) {
        if (samePath(had.hostPath, host) && !!had.readOnly === !!a.read_only) {
          const live = await sharesOf(c, a.vm);
          const cur = live && live.shares.find((s) => s.guestPath === guest);
          const same = Object.assign({ status: 'done', vm: a.vm, applied: 'unchanged', vm_status: vm.status }, summarizeShare(cur || had));
          if (live && live.problem) same.problem = live.problem;
          same.note = 'this folder was already shared there. ' + CAVEAT;
          return same;
        }
        throw new ToolError('guest_path ' + guest + ' of VM "' + a.vm + '" already shows ' + had.hostPath + (had.readOnly ? ' (read-only)' : '') +
          ' - call unshare_folder(vm="' + a.vm + '", guest_path="' + guest + '") first, or pick another guest_path');
      }
      const r = await sharesAction(c, { name: a.vm, action: 'add', hostPath: host, guestPath: guest, readOnly: !!a.read_only }, 'sharing ' + host + ' with "' + a.vm + '"');
      if (r.taskRunning) return Object.assign(r.taskRunning, { vm: a.vm, host_path: host, guest_path: guest });
      const live = await sharesOf(c, a.vm);
      const cur = live && live.shares.find((s) => s.guestPath === guest);
      const out = Object.assign({ status: 'done', vm: a.vm, vm_status: vm.status, applied: r.applied || null },
        summarizeShare(cur || { hostPath: (r.share && r.share.hostPath) || host, guestPath: guest, readOnly: !!a.read_only }));
      // the manager's own answer wins over a status read a moment later
      if (!cur && typeof r.mounted === 'boolean') out.mounted = r.mounted;
      if (r.warnings && r.warnings.length) out.warnings = r.warnings;
      if (live && live.problem) out.problem = live.problem;
      if (r.applied === 'next-start') out.when = 'the VM is not running - the folder is mounted when it starts (start_vm)';
      else if (r.pending === true || out.state === 'pending') out.when = 'being mounted in the background (the VM may first get the small guest service over SSH) - list_shares shows when it is mounted';
      else if (out.mounted === false) out.when = 'saved, but the VM has not mounted it yet - check again with list_shares in a few seconds; restarting the VM mounts it at boot';
      out.note = CAVEAT;
      out.next = 'Work on it in the VM with exec(name="' + a.vm + '", command="ls ' + guest + '"); unshare_folder(vm="' + a.vm + '", guest_path="' + guest + '") removes it.';
      return out;
    },
  });

  // ---------------------------------------------------------- unshare_folder
  tools.push({
    name: 'unshare_folder',
    title: 'Stop sharing a folder with a VM',
    description: 'Remove a shared folder from a VM: it is unmounted at once in a running VM (a program still using files there may get ' +
      'errors) and not mounted again at the next boot. The files on this PC are not touched. Removing a share that does not exist succeeds ' +
      '(removed: false).',
    params: {
      vm: vmP,
      guest_path: guestP('The folder inside the VM, as given to share_folder (list_shares shows them).'),
    },
    annotations: ann({ idempotentHint: true }),
    handler: async (a) => {
      const guest = checkGuestPath(a.guest_path);
      const c = await h.conn();
      const { vm } = await h.findVm(c, a.vm);
      if (Array.isArray(vm.shares) && !vm.shares.some((s) => s.guestPath === guest)) {
        return {
          status: 'done', vm: a.vm, guest_path: guest, removed: false,
          note: 'VM "' + a.vm + '" has no shared folder at ' + guest,
          shared_folders: vm.shares.map((s) => ({ host_path: s.hostPath, guest_path: s.guestPath, read_only: !!s.readOnly })),
        };
      }
      let r;
      try { r = await sharesAction(c, { name: a.vm, action: 'remove', guestPath: guest }, 'unsharing ' + guest + ' from "' + a.vm + '"'); }
      catch (e) {
        // removed meanwhile (or never there): the outcome asked for holds
        if (e && e.status === 404 && /shared folder/i.test(String(e.message))) {
          return { status: 'done', vm: a.vm, guest_path: guest, removed: false, note: 'VM "' + a.vm + '" has no shared folder at ' + guest };
        }
        throw e;
      }
      if (r.taskRunning) return Object.assign(r.taskRunning, { vm: a.vm, guest_path: guest });
      const out = { status: 'done', vm: a.vm, guest_path: guest, removed: true, applied: r.applied || null };
      if (r.warnings && r.warnings.length) out.warnings = r.warnings;
      out.note = (r.applied === 'live' ? 'unmounted in the running VM' : 'removed from the VM\'s settings') + '; the files on this PC are untouched';
      return out;
    },
  });

  // ------------------------------------------------------------- list_shares
  tools.push({
    name: 'list_shares',
    title: 'List shared folders',
    description: 'List the live shared folders of a VM (vm=...) or of a container started with run_image (container=...): the folder on this ' +
      'PC, where it appears inside, read-only or not, and the live status - mounted or not, open connections and files, bytes read and ' +
      'written, and the reason of the last disconnect (e.g. the guest rebooted or the folder was unshared). Give exactly one of vm and container.',
    params: {
      vm: { type: 'string', minLength: 1, description: 'Name of the VM.' },
      container: { type: 'string', minLength: 1, description: 'A container\'s name or id (run_image / list_containers).' },
    },
    annotations: RO,
    handler: async (a) => {
      if (!a.vm === !a.container) throw new ToolError('give exactly one of vm and container');
      const c = await h.conn();
      if (a.vm) {
        const { vm } = await h.findVm(c, a.vm);
        const live = await sharesOf(c, a.vm);
        const list = live ? live.shares : (vm.shares || []);
        const out = { vm: a.vm, vm_status: vm.status, count: list.length, shared_folders: list.map(summarizeShare) };
        if (live && live.problem) out.problem = live.problem;
        if (!live) out.note = 'settings only - this manager cannot report the live mount status';
        if (list.length) out.caveat = CAVEAT;
        return out;
      }
      const id = await h.getContainerId(c, a.container);
      const live = await sharesOf(c, id);
      const list = live ? live.shares : [];
      const out = { container: a.container, count: list.length, shared_folders: list.map(summarizeShare) };
      if (live && live.problem) out.problem = live.problem;
      if (!live) out.note = 'this manager cannot report shared folders of containers';
      if (list.length) out.caveat = CAVEAT;
      return out;
    },
  });

  return tools;
}

module.exports = { shareTools, CAVEAT, ACCESS_NOTE, checkGuestPath, samePath, summarizeShare };
