'use strict';
/*
 * QEMU command line for a headless "one image = one microVM" run (pure).
 *
 * buildQemuArgs(o) -> string[]  (argv without the qemu executable)
 *
 * o = {
 *   name,                          -name value
 *   machine: 'microvm' | 'q35',    microvm: virtio-mmio devices, no PCI/ACPI
 *                                  by default; q35: virtio-pci, ACPI power button
 *   accel: 'whpx'|'kvm'|'hvf'|'tcg', accelFallback (default true: add -accel tcg)
 *   whpxOpts: WHPX accelerator options from the host probe ('' = QEMU's
 *            defaults); when absent: whpxIrqchip (default false ->
 *            kernel-irqchip=off, as lib/vm.js did before the probe)
 *   cpus (1), memMB (256),
 *   kernel, initrd, append (string or array joined with ' '),
 *   console: {socket: {host, port, server} | {path, server}, logfile?}
 *            | {file, ...} | {null: true, logfile?}   -> ttyS0
 *   monitor: {host, port} | {path}  HMP monitor, QEMU listens (the same
 *                                   protocol as every VM: lib/monitor.js)
 *   net: false | {hostfwd: [{proto:'tcp'|'udp', hostAddr, hostPort, guestPort}],
 *                 restrict?: bool}                         (slirp user net)
 *   drives: [{id, path, format: 'raw'|'qcow2', readonly, serial, cache}],
 *   vports: [{name, chardev: {file} | {socket: {host, port, server}} }]
 *                                   virtio-serial ports (/dev/vportNpM,
 *                                   name in /sys/class/virtio-ports/X/name)
 *   rng: bool                       virtio-rng from host /dev/urandom equivalent
 *   fwcfg: [{name: 'opt/devbox/spec', file}]
 *   pidFile, noReboot (default true), paused (-S: CPU stopped until "cont"),
 *   cpu (-cpu model; under WHPX use hostcpu.whpxCpuModel: QEMU's default
 *        model lacks SSSE3/SSE4.x/POPCNT, "host"/"max" abort),
 *   tcgTbSizeMB (TCG translation cache, default 128; 0 = QEMU's default)
 * }
 *
 * CONTROL ENDPOINTS are the caller's: there is no default address here. The
 * manager uses the same private endpoints as for VMs (vm.runtimeEndpoints:
 * a fresh random 127.a.b.c + OS-assigned ports on Windows, unix sockets in a
 * private folder elsewhere). The prototype used a fixed 127.0.0.2 and a
 * probed port range, which let concurrent starts collide (bug V3) and made
 * the address predictable. 127.0.0.1 must never be used: slirp maps the
 * guests' 10.0.2.2 to it, and HMP can run programs on the host.
 *
 * Also exports: qv (QEMU option value escaping), MACHINE_DEFAULTS,
 * kernelAppend(opts) for the standard kernel command line, hostfwdRule,
 * chardevArg, TCG_TB_SIZE_MB.
 */

// QEMU option values are comma separated: a literal comma must be doubled.
const qv = (s) => String(s).replace(/,/g, ',,');

// microvm: keep the legacy devices the kernel needs to boot fast and nothing
// else. isa-serial gives ttyS0 early; rtc stays on (no rtc means the guest
// clock starts at 1970 - TLS cert checks in containers would fail);
// (x-option-roms=off must NOT be used: it drops the linuxboot option ROM
// and -kernel then never starts). pit/pic must be ON:
// with "auto" the kernel hangs at TSC calibration ("Unable to calibrate
// against PIT"), and under WHPX it hangs even with them on unless the TSC
// frequency is given (kernelAppend({tscKhz})).
const MACHINE_DEFAULTS = {
  microvm: 'microvm,isa-serial=on,rtc=on,pit=on,pic=on',
  q35: 'q35',
};

// TCG's translation-block cache defaults to 1 GiB on 64-bit hosts, and on
// Windows QEMU commits it up front: a 256 MB guest cost 1.33 GB of private
// memory (measured). A short-lived microVM needs far less; 0 = QEMU default.
const TCG_TB_SIZE_MB = 128;
const tbOf = (o) => (o.tcgTbSizeMB === undefined ? TCG_TB_SIZE_MB : o.tcgTbSizeMB);
const tcgArg = (o) => 'tcg' + (tbOf(o) ? ',tb-size=' + tbOf(o) : '');

function accelArgs(o) {
  const a = [];
  const accel = o.accel || 'tcg';
  if (accel === 'whpx') {
    // whpxOpts: the accelerator options the host probe chose (lib/hostprobe.js;
    // '' = QEMU's own defaults, which QEMU 11.1 tunes per Windows version);
    // without a probe, the explicit kernel-irqchip this engine always used
    const opts = o.whpxOpts !== undefined && o.whpxOpts !== null ? String(o.whpxOpts) : 'kernel-irqchip=' + (o.whpxIrqchip ? 'on' : 'off');
    a.push('-accel', 'whpx' + (opts ? ',' + opts : ''));
  }
  else if (accel === 'tcg') a.push('-accel', tcgArg(o));
  else a.push('-accel', accel);
  if (accel !== 'tcg' && o.accelFallback !== false) a.push('-accel', tcgArg(o));
  if (o.cpu) a.push('-cpu', o.cpu);
  else if (accel === 'tcg' || accel === 'kvm' || accel === 'hvf') a.push('-cpu', 'max');
  return a;
}

function hostfwdRule(f) {
  const proto = f.proto || 'tcp';
  const addr = f.hostAddr === undefined ? '127.0.0.1' : f.hostAddr;
  return proto + ':' + addr + ':' + f.hostPort + '-:' + f.guestPort;
}

// A socket endpoint must name its address: {path} or {host, port}. Which
// address is safe is decided in ONE place, platform.internalHost() (it only
// returns 127.0.0.1 when config.json explicitly allows it).
function socketWhere(s, what) {
  if (s.path) return 'path=' + qv(s.path);
  if (!s.host || !s.port) throw new Error(what + ' needs {host, port} or {path} (no default address: see "CONTROL ENDPOINTS")');
  return 'host=' + s.host + ',port=' + s.port;
}

function chardevArg(id, c) {
  if (c.socket) {
    const s = c.socket;
    let v = 'socket,id=' + id + ',' + socketWhere(s, 'chardev ' + id);
    v += s.server ? ',server=on,wait=off' : '';
    if (c.logfile) v += ',logfile=' + qv(c.logfile) + ',logappend=off';
    return v;
  }
  if (c.file) return 'file,id=' + id + ',path=' + qv(c.file);
  if (c.null) return 'null,id=' + id + (c.logfile ? ',logfile=' + qv(c.logfile) + ',logappend=off' : '');
  throw new Error('chardev needs socket, file or null');
}

function buildQemuArgs(o) {
  const machine = o.machine || 'microvm';
  const mmio = machine === 'microvm';
  const dev = (pci, mm) => (mmio ? mm : pci);
  const a = ['-name', o.name || 'devbox-microvm', '-nodefaults', '-no-user-config'];
  a.push('-machine', MACHINE_DEFAULTS[machine] || machine);
  a.push(...accelArgs(o));
  a.push('-smp', String(o.cpus || 1), '-m', String(o.memMB || 256));
  a.push('-display', 'none');
  if (o.noReboot !== false) a.push('-no-reboot');
  if (o.bios) a.push('-bios', o.bios);
  a.push('-kernel', o.kernel);
  if (o.initrd) a.push('-initrd', o.initrd);
  const append = Array.isArray(o.append) ? o.append.join(' ') : (o.append || '');
  if (append) a.push('-append', append);

  // console -> ttyS0
  if (o.console) {
    a.push('-chardev', chardevArg('con0', o.console));
    a.push('-serial', 'chardev:con0');
  } else {
    a.push('-serial', 'none');
  }
  // HMP monitor (system_powerdown, quit, hostfwd_add/remove)
  if (o.monitor) {
    a.push('-chardev', chardevArg('mon0', { socket: Object.assign({}, o.monitor, { server: true }) }));
    a.push('-mon', 'chardev=mon0,mode=readline');
  }

  if (o.net) {
    let nd = 'user,id=n0';
    if (o.net.restrict) nd += ',restrict=on';
    for (const f of o.net.hostfwd || []) nd += ',hostfwd=' + hostfwdRule(f);
    a.push('-netdev', nd, '-device', dev('virtio-net-pci', 'virtio-net-device') + ',netdev=n0' + (o.net.mac ? ',mac=' + o.net.mac : ''));
  }
  for (const [i, d] of (o.drives || []).entries()) {
    const id = d.id || 'vd' + i;
    let dr = 'file=' + qv(d.path) + ',if=none,id=' + id + ',format=' + (d.format || 'raw');
    if (d.readonly) dr += ',readonly=on';
    dr += ',cache=' + (d.cache || 'writeback') + ',discard=unmap';
    a.push('-drive', dr);
    a.push('-device', dev('virtio-blk-pci', 'virtio-blk-device') + ',drive=' + id + (d.serial ? ',serial=' + qv(d.serial) : ''));
  }
  if (o.vports && o.vports.length) {
    a.push('-device', dev('virtio-serial-pci', 'virtio-serial-device') + ',id=vser0,max_ports=' + Math.max(2, o.vports.length + 1));
    o.vports.forEach((p, i) => {
      a.push('-chardev', chardevArg('vp' + i, p.chardev));
      a.push('-device', 'virtserialport,bus=vser0.0,nr=' + (i + 1) + ',chardev=vp' + i + ',name=' + p.name);
    });
  }
  if (o.rng) {
    a.push('-object', 'rng-builtin,id=rng0');
    a.push('-device', dev('virtio-rng-pci', 'virtio-rng-device') + ',rng=rng0');
  }
  for (const f of o.fwcfg || []) a.push('-fw_cfg', 'name=' + f.name + ',file=' + qv(f.file));
  if (o.pidFile) a.push('-pidfile', o.pidFile);
  if (o.paused) a.push('-S'); // start with the CPU stopped ("cont" runs it)
  return a;
}

// Standard kernel command line for the microVM engine.
// opts: {console: 'ttyS0'|'hvc0', quiet (true), extra: []}
function kernelAppend(opts) {
  opts = opts || {};
  const a = [
    'console=' + (opts.console || 'ttyS0'),
    'rdinit=/.devbox/init',
    'panic=-1',           // init died -> reboot at once (QEMU -no-reboot exits)
    'reboot=t',           // reboot via triple fault: works without ACPI/i8042
    // the initramfs tmpfs is capped at 50% of RAM while the kernel unpacks
    // it; a 51 MB image then needs 208 MB of RAM instead of ~190 (Linux >= 6.17)
    'initramfs_options=size=90%',
  ];
  if (opts.quiet !== false) a.push('quiet', 'loglevel=1');
  if (opts.fast !== false) {
    a.push('8250.nr_uarts=' + (opts.nrUarts || 1), 'i8042.noaux', 'i8042.nomux', 'i8042.nopnp', 'i8042.dumbkbd',
      'random.trust_cpu=on', 'tsc=reliable', 'no_timer_check', 'cryptomgr.notests', 'mitigations=off');
  }
  // microvm under WHPX: no HPET/ACPI PM timer to calibrate the TSC against
  if (opts.tscKhz) a.push('tsc_early_khz=' + Math.round(opts.tscKhz));
  return a.concat(opts.extra || []);
}

module.exports = { buildQemuArgs, kernelAppend, qv, MACHINE_DEFAULTS, hostfwdRule, chardevArg, accelArgs, TCG_TB_SIZE_MB };
