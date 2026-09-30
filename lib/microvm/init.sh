#!/.devbox/busybox sh
# devbox microVM init (PID 1). Runs one container process, then powers off.
#
# Layout in the initramfs (put there by the host, see initramfs.js):
#   /.devbox/busybox      static busybox; every tool below runs through it,
#                         so nothing depends on what the image contains
#   /.devbox/init         this script (kernel arg rdinit=/.devbox/init)
#   the run spec          rendered by the host with every value single-quoted
#                         (renderSpec), read from the QEMU fw_cfg file
#                         opt/devbox/spec (cached initrds); /.devbox/spec.sh
#                         in a per-run archive only when fw_cfg has none
#   /.devbox/modules/*.ko kernel modules, loaded in DEVBOX_MODULES order
#   /.devbox/vols/<serial> ext4 volume mounts (their data/ is bind-mounted)
#
# Console (ttyS0) protocol; kernel messages go there too:
#   __DEVBOX_INIT uptime=S   init started
#   __DEVBOX_STOPPING        a stop request was ACCEPTED (sent for every
#                            request, so the host can resend until it sees it)
#   __DEVBOX_SIGNAL=<SIG>    a signal request was passed on
#   __DEVBOX_READY           setup done, the container process starts now
#   __DEVBOX_ERROR=<text>    why init gave up (one line, at most 300 chars)
#   __DEVBOX_NOSTART         a stop came before the app started: it never ran
#   __DEVBOX_EXIT=<code>     the container process exited (always last)
# Container stdout/stderr go to the virtio-serial ports devbox.stdout /
# devbox.stderr when the host attached them (the 8250 console manages only
# a few KB/s under WHPX), else to the console.
# Host -> guest, typed on the console (echo off; the container's stdin is
# /dev/null, so it never sees these):
#   __DEVBOX_STOP [timeout]  graceful stop: the image's stop signal, then
#                            SIGKILL after timeout (default
#                            DEVBOX_STOP_TIMEOUT) seconds
#   __DEVBOX_KILL <SIG>      send one signal to the container process
# The reader starts right after the spec is read - before modules, volumes,
# shared folders and copy-in - so a stop during boot is never lost (bug V2):
# the host resends every second until __DEVBOX_STOPPING appears, because a
# write to the console socket is not a delivery (the 8250 FIFO is reset when
# its driver loads). A stop accepted before the app started skips the app.
# An ACPI power-button press (HMP system_powerdown; q35 and microvm, whose
# ACPI GED is on by default) = __DEVBOX_STOP when the spec loaded
# button+evdev (acpiButton).
#
# The container process runs as a FOREGROUND job: a non-interactive shell
# starts background jobs with SIGINT/SIGQUIT ignored, and "ignored" survives
# exec. In the foreground it gets default dispositions, as under Docker.
# While init blocks in that wait, ash reaps with waitpid(-1), so orphans
# re-parented to PID 1 are reaped too. Background helpers do the signalling.

B=/.devbox/busybox
R=/.devbox/run
# defaults; spec.sh overrides them
DEVBOX_HOSTNAME=devbox
DEVBOX_WORKDIR=/
DEVBOX_USER=
DEVBOX_NET=1
DEVBOX_IP=10.0.2.15/24
DEVBOX_GW=10.0.2.2
DEVBOX_DNS=10.0.2.3
DEVBOX_STOP_SIGNAL=TERM
DEVBOX_STOP_TIMEOUT=10
DEVBOX_MODULES=
DEVBOX_DEBUG=0
DEVBOX_TRIM=1
DEVBOX_TTY=/dev/ttyS0
DEVBOX_COPYIN=0
DEVBOX_COPYIN_OWNER=user
# per-boot output cap per stream (bytes); 0 = unlimited
DEVBOX_LOG_CAP=1073741824
devbox_volumes() { :; }
devbox_shares() { :; }
devbox_mounts() { devbox_volumes || return 1; devbox_shares; }
devbox_copyin_targets() { :; }
devbox_hosts() { :; }
devbox_sysctls() { :; }
devbox_exec() { exec "$@" /bin/sh; }

say() { echo "devbox-init: $*" >/dev/console; }
dbg() { [ "$DEVBOX_DEBUG" = 1 ] && say "$@"; return 0; }
marker() { echo "__DEVBOX_$*" >/dev/console; }

# Unmount the volumes (bind mounts first, then the ext4 mounts: reverse order
# of mounting); fstrim hands blocks freed by the container back to the host
# image (qcow2 with discard=unmap) before the file system is unmounted.
unmount_volumes() {
  [ -f "$R/volumes" ] || return 0
  # one path per line (a target may contain spaces)
  $B tac "$R/volumes" >"$R/volumes.rev"
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    case "$v" in /.devbox/vols/*) [ "$DEVBOX_TRIM" = 1 ] && $B fstrim "$v" 2>/dev/null ;; esac
    i=0
    until $B umount "$v" 2>/dev/null; do
      i=$((i + 1))
      if [ $i -ge 25 ]; then $B mount -o remount,ro "$v" 2>/dev/null || say "cannot unmount $v"; break; fi
      $B usleep 20000
    done
  done <"$R/volumes.rev"
  $B rm -f "$R/volumes" "$R/volumes.rev"
  $B sync
}

# die CODE TEXT: give up before the app ran. The text goes to the console
# and, as __DEVBOX_ERROR=, to the host, which shows it as the exit reason
# (bug V8: a bare 125/126 said nothing).
die() {
  say "$2"
  marker "ERROR=$(printf '%s' "$2" | $B tr '\n\r' '  ' | $B head -c 300)"
  $B sync
  unmount_volumes
  marker "EXIT=$1"
  $B poweroff -f
  $B reboot -f
}

# ---------------------------------------------------------------- mounts
$B mkdir -p /proc /sys /dev /run "$R"
$B mount -t proc -o nosuid,nodev,noexec proc /proc
$B mount -t sysfs -o nosuid,nodev,noexec sysfs /sys
$B mount -t devtmpfs -o nosuid,mode=0755 devtmpfs /dev 2>/dev/null
exec 0</dev/null 1>/dev/console 2>&1
marker "INIT uptime=$($B cut -d' ' -f1 /proc/uptime)"
# The spec comes from the host as a QEMU fw_cfg file, so that one cached
# initrd serves every run of an image:
#   -fw_cfg name=opt/devbox/spec,file=<spec.sh>
# It is read FIRST: /.devbox/spec.sh in the archive is only a fallback for a
# per-run init archive without fw_cfg (tests) - an image must never be able
# to replace the manager's spec by shipping that file (the flattener also
# drops /.devbox from image layers). qemu_fw_cfg also serves the
# shared-folder list (opt/devbox/shares).
SPEC=
$B insmod /.devbox/modules/qemu_fw_cfg.ko 2>/dev/null
f=/sys/firmware/qemu_fw_cfg/by_name/opt/devbox/spec/raw
[ -r "$f" ] && $B cat "$f" >"$R/spec.sh" && [ -s "$R/spec.sh" ] && SPEC=$R/spec.sh
[ -n "$SPEC" ] || SPEC=/.devbox/spec.sh
[ -r "$SPEC" ] && . "$SPEC" || die 125 "no run spec (neither fw_cfg opt/devbox/spec nor /.devbox/spec.sh)"

# ------------------------------------------------------- stop requests
# console: raw output (a "\n" stays "\n" in the log) and no echo of the
# host's commands (an echoed "__DEVBOX_STOP" must never look like output)
$B stty -F "$DEVBOX_TTY" -opost -echo 2>/dev/null || dbg "stty failed"
send_sig() {
  p=$($B cat "$R/child.pid" 2>/dev/null)
  [ -n "$p" ] && kill -s "$1" "$p" 2>/dev/null
}
# The "stopping" flag is created BEFORE child.pid is read, and the exec
# wrapper below writes child.pid BEFORE it checks the flag: whichever way a
# stop and the app's start interleave, the app either never starts or gets
# the stop signal.
request_stop() {
  [ -e "$R/stopping" ] && return 0
  $B touch "$R/stopping"
  t=${1:-$DEVBOX_STOP_TIMEOUT}
  case "$t" in '' | *[!0-9]*) t=$DEVBOX_STOP_TIMEOUT ;; esac
  if [ -s "$R/child.pid" ]; then
    send_sig "$DEVBOX_STOP_SIGNAL"
    ($B sleep "$t"; send_sig KILL) &
  fi
}
(
  while read -r cmd arg; do
    case "$cmd" in
      __DEVBOX_STOP)
        request_stop "$arg"
        marker STOPPING
        ;;
      __DEVBOX_KILL)
        s=${arg:-KILL}
        case "$s" in '' | *[!A-Z0-9]*) continue ;; esac
        if [ ! -s "$R/child.pid" ]; then
          # nothing runs yet: a terminating signal means "do not start it"
          case "$s" in KILL | TERM | INT | QUIT) request_stop 0; marker STOPPING ;; esac
          continue
        fi
        send_sig "$s"
        marker "SIGNAL=$s"
        [ "$s" = KILL ] && marker STOPPING
        ;;
    esac
  done <"$DEVBOX_TTY"
) &
helpers=$!

$B mkdir -p /dev/pts /dev/shm /dev/mqueue /sys/fs/cgroup
$B mount -t devpts -o nosuid,noexec,newinstance,ptmxmode=0666,mode=0620,gid=5 devpts /dev/pts
$B ln -sf pts/ptmx /dev/ptmx
# /dev/shm as Docker sizes it
$B mount -t tmpfs -o nosuid,nodev,mode=1777,size=64m shm /dev/shm
$B mount -t mqueue -o nosuid,nodev,noexec mqueue /dev/mqueue 2>/dev/null
$B mount -t cgroup2 -o nosuid,nodev,noexec cgroup2 /sys/fs/cgroup 2>/dev/null
[ -e /dev/fd ] || $B ln -s /proc/self/fd /dev/fd
[ -e /dev/stdin ] || $B ln -s /proc/self/fd/0 /dev/stdin
[ -e /dev/stdout ] || $B ln -s /proc/self/fd/1 /dev/stdout
[ -e /dev/stderr ] || $B ln -s /proc/self/fd/2 /dev/stderr
# the root is the initramfs tmpfs; the real cap is set just before the app
# starts (cap_root below)
$B mount -o remount,size=90% / 2>/dev/null || dbg "cannot resize /"
# /tmp: the root is already RAM, so a plain 1777 directory (as in Docker)
$B mkdir -p /tmp && $B chmod 1777 /tmp
# a tmpfs root starts as 1777; an image root is 0755
$B chmod 755 /
echo 1 >/proc/sys/kernel/printk

# --------------------------------------------------------------- modules
for m in $DEVBOX_MODULES; do
  [ -d "/sys/module/$m" ] || $B insmod "/.devbox/modules/$m.ko" || dbg "insmod $m failed"
done
# the module files are RAM in the tmpfs root: free them
$B rm -rf /.devbox/modules
# the ACPI power button = a stop request, armed as soon as its driver is in
for d in /sys/class/input/event*; do
  [ -r "$d/device/name" ] || continue
  case "$($B cat "$d/device/name")" in
    *"Power Button"*)
      # devtmpfs creates the node asynchronously: make it if still missing
      node=/dev/input/${d##*/}
      if [ ! -c "$node" ]; then
        IFS=: read -r maj min <"$d/dev"
        $B mkdir -p /dev/input && $B mknod "$node" c "$maj" "$min" 2>/dev/null
      fi
      ($B dd if="$node" bs=24 count=1 >/dev/null 2>&1 && request_stop && marker STOPPING) &
      helpers="$helpers $!"
      ;;
  esac
done

# --------------------------------------------------------------- network
$B hostname "$DEVBOX_HOSTNAME"
$B ip link set lo up
if [ "$DEVBOX_NET" = 1 ] && [ -e /sys/class/net/eth0 ]; then
  $B ip addr add "$DEVBOX_IP" dev eth0
  $B ip link set eth0 up
  $B ip route add default via "$DEVBOX_GW" dev eth0
fi
$B mkdir -p /etc
$B rm -f /etc/resolv.conf /etc/hostname /etc/hosts
if [ "$DEVBOX_NET" = 1 ]; then echo "nameserver $DEVBOX_DNS" >/etc/resolv.conf; else $B touch /etc/resolv.conf; fi
echo "$DEVBOX_HOSTNAME" >/etc/hostname
{
  printf '127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n'
  [ "$DEVBOX_NET" = 1 ] && printf '%s\t%s\n' "${DEVBOX_IP%/*}" "$DEVBOX_HOSTNAME"
  devbox_hosts
} >/etc/hosts
# what Docker sets in every container
echo 0 >/proc/sys/net/ipv4/ip_unprivileged_port_start
echo "0 2147483647" >/proc/sys/net/ipv4/ping_group_range
devbox_sysctls
# open files as Docker 25+/containerd set them (1024 soft, 524288 hard);
# the kernel's default for init is 1024:4096. Inherited by the container.
ulimit -H -n 524288 2>/dev/null && ulimit -S -n 1024 2>/dev/null

# --------------------------------------------------------------- volumes
# devbox_volume SERIAL TARGET [ro|rw] [nocopy]: the virtio-blk disk whose
# serial is SERIAL (ext4, formatted by the host) is mounted at
# /.devbox/vols/SERIAL and its "data" directory is bind-mounted at TARGET,
# so the container never sees lost+found (initdb/mysqld refuse a data dir
# that has one). On first use "data" is created and, like a new Docker named
# volume, gets the image's content, owner and mode at TARGET (copy-up)
# unless "nocopy".
# disk_by_serial SERIAL -> /dev/vdX of the virtio-blk disk with that serial
disk_by_serial() {
  local s n=0
  for s in /sys/block/vd*/serial; do
    [ -r "$s" ] || continue
    if [ "$($B cat "$s")" = "$1" ]; then
      s=${s%/serial}; s=/dev/${s##*/}
      # devtmpfs makes the node asynchronously after the probe
      while [ ! -b "$s" ] && [ $n -lt 50 ]; do $B usleep 20000; n=$((n + 1)); done
      echo "$s"
      return 0
    fi
  done
  return 1
}
# fail TEXT: report a setup failure; the caller's die() repeats it to the host
fail() { FAILED=$1; say "$1"; return 1; }
FAILED=
devbox_volume() {
  dev=$(disk_by_serial "$1") || { fail "the disk of volume $1 was not found"; return 1; }
  m=/.devbox/vols/$1
  $B mkdir -p "$m"
  o=rw; [ "$3" = ro ] && o=ro
  $B mount -t ext4 -o "$o,noatime" "$dev" "$m" || { fail "cannot mount the disk of volume $1 ($dev)"; return 1; }
  echo "$m" >>"$R/volumes"
  if [ ! -d "$m/data" ]; then
    [ "$o" = ro ] && { fail "volume $1 is empty and read-only"; return 1; }
    # The copy-up is ATOMIC (correct-10): it fills data.new, and only a
    # complete copy is renamed to data - "data exists" is what marks a
    # volume as seeded. A copy that fails (the volume is too small) or is
    # cut short (a stop or a panic during boot) is thrown away and redone
    # at the next start, never used half-done.
    $B rm -rf "$m/data.new"
    $B mkdir "$m/data.new" || { fail "cannot write to volume $1"; return 1; }
    if [ -d "$2" ] && [ "$4" != nocopy ]; then
      if ! $B cp -a "$2/." "$m/data.new/"; then
        $B rm -rf "$m/data.new"
        fail "copy-up of $2 to volume $1 failed (is the volume too small?)"
        return 1
      fi
      $B chown "$($B stat -c %u:%g "$2")" "$m/data.new"
      $B chmod "$($B stat -c %a "$2")" "$m/data.new"
    fi
    $B sync
    $B mv "$m/data.new" "$m/data" || { fail "cannot finish the copy-up of volume $1"; return 1; }
    $B sync
  fi
  $B mkdir -p "$2"
  $B mount --bind "$m/data" "$2" || { fail "cannot mount volume $1 at $2"; return 1; }
  [ "$o" = ro ] && $B mount -o remount,bind,ro "$2"
  echo "$2" >>"$R/volumes"
  echo "v $1 $o $2" >>"$R/mounts"
}

# --------------------------------------------------------- shared folders
# devbox_share ID TARGET [ro|rw]: a LIVE host folder, served by the
# manager's own 9P2000.L server on the host's 127.0.0.1 (slirp: 10.0.2.2).
# The port and the share's secret come from the fw_cfg file
# opt/devbox/shares ("<port> <id>:<secret> <path> <rw|ro>" per line; the
# path there is the manager's internal one - TARGET comes from the spec), so
# the secret is never on a command line. A folder that cannot be mounted
# fails the start (exit 125) with the reason: an app must never silently
# write into its RAM root instead of the user's folder.
SHARES_CFG=/sys/firmware/qemu_fw_cfg/by_name/opt/devbox/shares/raw
BOOT_ID=$($B cat /proc/sys/kernel/random/boot_id 2>/dev/null)
share_opts() {
  sp='' sc=''
  if [ -r "$SHARES_CFG" ]; then
    while read -r p c _ _; do
      case "$c" in "$1":*) sp=$p sc=$c; break ;; esac
    done <"$SHARES_CFG"
  fi
  [ -n "$sc" ] || return 1
  so="trans=tcp,port=$sp,version=9p2000.L,msize=524288,cache=mmap,aname=$sc"
  # the server closes a previous boot's mounts of the share when a new boot
  # mounts with a different id
  [ -n "$BOOT_ID" ] && so="$so,uname=boot-$BOOT_ID"
  [ "$2" = ro ] && so="$so,ro"
  return 0
}
# Every attempt is bounded: while the manager is away, slirp may leave the
# guest's TCP connect unanswered, and a mount blocked there would never
# return - not even once the manager is back (measured: still blocked after
# a minute), so the healing below would stall for good.
share_mount() {
  share_opts "$1" "$3" || { echo "the shared folder list has no entry $1"; return 1; }
  $B timeout -s KILL 10 $B mount -t 9p -o "$so" 10.0.2.2 "$2" 2>&1
}
devbox_share() {
  [ "$DEVBOX_NET" = 1 ] || { fail "the shared folder at $2 needs the network (it is served over it)"; return 1; }
  $B mkdir -p "$2" || { fail "cannot create $2 for a shared folder"; return 1; }
  n=0
  until e=$(share_mount "$1" "$2" "$3"); do
    n=$((n + 1))
    if [ $n -ge 5 ]; then fail "cannot mount the shared folder at $2: $e"; return 1; fi
    $B usleep 200000
  done
  echo "$1 $2 $3" >>"$R/shares"
  echo "s $1 $3 $2" >>"$R/mounts"
}
# Volumes and shared folders are mounted in ONE list, parents before
# children (the spec renders devbox_mounts sorted by target depth, as
# Docker sorts its mounts): a volume under a shared folder - the usual
# "project folder shared, node_modules in a volume" - or a volume under
# another volume would otherwise be hidden by the mount that came later
# (correct-1). $R/mounts keeps that order ("v|s ID MODE TARGET" per line).
# An older spec without devbox_mounts gets volumes, then shared folders.
devbox_mounts || die 125 "setup failed: ${FAILED:-a volume or shared folder could not be mounted}"
# share_heal ID TARGET MODE: replace a dead mount by a fresh one. The new
# mount is made at a private point FIRST and only then moved over the
# target (after a lazy unmount of the dead one): while the manager is still
# away nothing is unmounted, so the app never sees the directory under the
# mount point - an nginx would otherwise serve the image's own files.
# The lazy unmount also detaches every mount BELOW the target (a volume at
# /app/node_modules under a share at /app): those are mounted again on the
# fresh share (remount_nested).
share_heal() {
  p="$R/remount-$1"
  $B mkdir -p "$p"
  if ! e=$(share_mount "$1" "$p" "$3"); then
    # say it once per outage (the loop retries every 3 s)
    [ -e "$p.said" ] || { : >"$p.said"; say "shared folder at $2 is not reachable (the manager is away?) - retrying: $e"; }
    return 1
  fi
  $B rm -f "$p.said"
  $B umount -l "$2" 2>/dev/null
  if e=$($B mount --move "$p" "$2" 2>&1); then
    say "shared folder at $2 re-mounted"
    [ "$4" = nested ] || remount_nested "$2"
    return 0
  fi
  say "shared folder at $2: re-mount failed: $e"
  $B umount -l "$p" 2>/dev/null
  return 1
}
# remount_nested TARGET: mount again, in the original order, everything that
# was mounted below TARGET (the lazy unmount of TARGET took it along).
remount_nested() {
  [ -s "$R/mounts" ] || return 0
  while read -r k id mode t; do
    case "$t" in "$1"/*) ;; *) continue ;; esac
    $B mkdir -p "$t" 2>/dev/null
    if [ "$k" = v ]; then
      if $B mount --bind "/.devbox/vols/$id/data" "$t" 2>/dev/null; then
        [ "$mode" = ro ] && $B mount -o remount,bind,ro "$t"
        say "volume $id at $t mounted again"
      else
        say "volume $id at $t could not be mounted again after its parent folder was re-mounted"
      fi
    else
      share_heal "$id" "$t" "$mode" nested || say "shared folder at $t could not be mounted again after its parent folder was re-mounted"
    fi
  done <"$R/mounts"
}
if [ -s "$R/shares" ]; then
  # The Linux 9p TCP transport never reconnects: when the manager restarts,
  # these mounts die (statfs fails at once). The new manager registers the
  # same share and secret again; a folder whose statfs failed twice, 3 s
  # apart, is healed (above), and tried again every 3 s until that works.
  (
    bad=
    while $B sleep 3; do
      next=
      while read -r id t mode; do
        if $B stat -f "$t" >/dev/null 2>&1; then continue; fi
        case " $bad " in
          *" $id "*) share_heal "$id" "$t" "$mode" || next="$next $id" ;;
          *) next="$next $id" ;;
        esac
      done <"$R/shares"
      bad=$next
    done
  ) &
  helpers="$helpers $!"
fi

# ------------------------------------------------------------------ user
# DEVBOX_USER as in Docker's USER: "", name, uid, name:group, uid:gid
U_UID=0 U_GID=0 U_HOME=/
if [ -z "$DEVBOX_USER" ]; then
  # runc: HOME comes from the passwd entry of the uid (root -> /root),
  # "/" when there is none (scratch images)
  if [ -r /etc/passwd ]; then
    while IFS=: read -r n _ pu pg _ ph _; do
      [ "$pu" = 0 ] && { U_HOME=${ph:-/}; break; }
    done </etc/passwd
  fi
else
  u=${DEVBOX_USER%%:*} g=
  case "$DEVBOX_USER" in *:*) g=${DEVBOX_USER#*:} ;; esac
  found=
  if [ -r /etc/passwd ]; then
    while IFS=: read -r n _ pu pg _ ph _; do
      if [ "$n" = "$u" ] || [ "$pu" = "$u" ]; then U_UID=$pu U_GID=$pg U_HOME=${ph:-/} found=1; break; fi
    done </etc/passwd
  fi
  if [ -z "$found" ]; then
    case "$u" in '' | *[!0-9]*) die 126 "unable to find user $u: no matching entries in passwd file" ;; esac
    U_UID=$u U_GID=0
  fi
  if [ -n "$g" ]; then
    case "$g" in
      *[!0-9]*)
        U_GID=
        if [ -r /etc/group ]; then
          while IFS=: read -r n _ gg _; do
            [ "$n" = "$g" ] && { U_GID=$gg; break; }
          done </etc/group
        fi
        [ -n "$U_GID" ] || die 126 "unable to find group $g: no matching entries in group file"
        ;;
      *) U_GID=$g ;;
    esac
  fi
fi
# privilege drop: busybox nsenter with no namespace = setgroups(0), setgid,
# setuid, exec (this busybox has no chpst/setuidgid; its setpriv has no
# --reuid). Supplementary groups are therefore always empty.
PRIV=
if [ "$U_UID" != 0 ] || [ "$U_GID" != 0 ]; then PRIV="$B nsenter -S $U_UID -G $U_GID --"; fi

# --------------------------------------------------------------- copy-in
# Host folders (run --copy-in DIR:/target) arrive as ONE newc archive, a
# read-only raw virtio-blk disk with serial "devbox-copyin" (not fw_cfg: its
# sysfs reads cost O(size^2) port exits): entries already sit at their target
# paths, plus .devbox/run/copyin.list (one extracted path per line). Extracted after
# the volumes are mounted (a target inside a volume lands in the volume) and
# owned by the container user, like a host folder bind-mounted into a
# container (DEVBOX_COPYIN_OWNER=root keeps root). Missing targets are made
# first; existing ones keep their owner and mode.
devbox_copyin_target() {
  [ -d "$1" ] && return 0
  $B mkdir -p "$1" || return 1
  [ "$DEVBOX_COPYIN_OWNER" = root ] || $B chown "$U_UID:$U_GID" "$1"
}
if [ "$DEVBOX_COPYIN" = 1 ]; then
  f=$(disk_by_serial devbox-copyin) || die 125 "copy-in: no archive disk (serial devbox-copyin)"
  devbox_copyin_targets || die 125 "copy-in: cannot create the target directories"
  (cd / && $B cpio -i -d -m -u <"$f") 2>"$R/copyin.err" ||
    die 125 "copy-in failed: $($B tail -n 3 "$R/copyin.err")"
  if [ "$DEVBOX_COPYIN_OWNER" != root ] && [ -r "$R/copyin.list" ]; then
    (cd / && $B tr '\n' '\0' <"$R/copyin.list" | $B xargs -0 -r $B chown -h "$U_UID:$U_GID") ||
      say "copy-in: chown to $U_UID:$U_GID failed"
  fi
  $B rm -f "$R/copyin.list" "$R/copyin.err"
  dbg "copy-in done at $($B cut -d' ' -f1 /proc/uptime)"
fi

# -------------------------------------------------------- RAM root cap
# Everything the app writes outside volumes and shared folders lands in RAM.
# Cap the root at what it holds now plus half of the memory still
# available: a full root then gives ENOSPC to the app instead of "System is
# deadlocked on memory" and a kernel panic (bug V6).
cap_root() {
  set -- $($B stat -f -c '%b %f %S' / 2>/dev/null)
  [ -n "$3" ] && [ "$1" -gt 0 ] 2>/dev/null || return 0
  used=$((($1 - $2) * $3 / 1024))
  avail=
  while read -r k v _; do
    [ "$k" = MemAvailable: ] && { avail=$v; break; }
  done </proc/meminfo
  [ -n "$avail" ] || return 0
  $B mount -o remount,size=$((used + avail / 2))k / 2>/dev/null || dbg "cannot cap /"
}
cap_root

# ----------------------------------------------------------------- run
[ -d "$DEVBOX_WORKDIR" ] || $B mkdir -p "$DEVBOX_WORKDIR"
cd "$DEVBOX_WORKDIR" || cd /
# Output: stdout/stderr are pipes, not a tty (as with "docker run" without
# -t: no colours, block buffering). Relays copy them to virtio-serial ports
# "devbox.stdout" / "devbox.stderr" when the host attached them (bulk
# transfers; the 8250 console manages only ~10 KB/s under WHPX), otherwise
# to the console. No stderr port: stderr joins stdout.
port_dev() {
  for n in /sys/class/virtio-ports/*/name; do
    [ -r "$n" ] && [ "$($B cat "$n")" = "$1" ] && { d=${n%/name}; echo "/dev/${d##*/}"; return 0; }
  done
  return 1
}
# Log cap (bug E): at most DEVBOX_LOG_CAP bytes of one stream per boot, so a
# chatty app cannot fill the host's disk. The relays stay plain "cat"
# (unbuffered, no per-chunk process - busybox head -c goes through stdio and
# would hold short log lines back); a watchdog reads each relay's written
# byte count (/proc/<pid>/io wchar) every 2 s and swaps a relay that passed
# the cap for a reader that drops the rest - that reader opens the pipe
# BEFORE the relay goes, so the app never sees a pipe without a reader.
start_capwatch() {
  [ "$DEVBOX_LOG_CAP" -gt 0 ] 2>/dev/null || return 0
  (
    left="$*"
    while [ -n "$left" ] && $B sleep 2; do
      next=
      for e in $left; do
        p=${e%%:*} rest=${e#*:}
        f=${rest%%:*} name=${rest#*:}
        w=
        if [ -r "/proc/$p/io" ]; then
          while read -r k v; do [ "$k" = wchar: ] && { w=$v; break; }; done <"/proc/$p/io"
        fi
        if [ -n "$w" ] && [ "$w" -ge "$DEVBOX_LOG_CAP" ] 2>/dev/null; then
          $B cat "$f" >/dev/null &
          kill "$p" 2>/dev/null
          say "$name reached the log limit of $DEVBOX_LOG_CAP bytes for this boot: the rest is not kept"
        elif [ -d "/proc/$p" ]; then
          next="$next $e"
        fi
      done
      left=$next
    done
  ) &
  helpers="$helpers $!"
}
code=0
relays=
if [ -e "$R/stopping" ]; then
  # Stopped during setup: the app never starts. Decided BEFORE any pipe or
  # relay exists, because PID 1 must never block opening a FIFO: a SIGCHLD
  # (a relay ending) interrupts that open with EINTR, a failed redirection
  # of a shell builtin ends a non-interactive shell - and PID 1 ending is a
  # kernel panic (seen once in ~40 stops 0.5 s into a boot).
  $B touch "$R/nostart"
else
  out_dev=$(port_dev devbox.stdout) || out_dev=/dev/console
  err_dev=$(port_dev devbox.stderr) || err_dev=
  # the pipes belong to the container user (runc does the same with its
  # stdio pipes): images like nginx log to /var/log/nginx/error.log ->
  # /dev/stderr, which re-opens the pipe through /proc/self/fd/2 and needs
  # permission
  $B mkfifo -m 0600 "$R/out"
  $B chown "$U_UID:$U_GID" "$R/out"
  $B cat "$R/out" >"$out_dev" &
  relays=$!
  capped="$!:$R/out:stdout"
  if [ -n "$err_dev" ]; then
    $B mkfifo -m 0600 "$R/err"
    $B chown "$U_UID:$U_GID" "$R/err"
    $B cat "$R/err" >"$err_dev" &
    relays="$relays $!"
    capped="$capped $!:$R/err:stderr"
    err_to="$R/err"
  else
    err_to="$R/out"
  fi
  [ "$out_dev" = /dev/console ] || start_capwatch $capped
  dbg "output to $out_dev ${err_dev:-(stderr merged)}"
  marker READY
  # the "sh -c" writes its own pid, which the container process keeps
  # through the execs (sh -> [nsenter ->] env -> program); a stop that came
  # in meanwhile is seen after the pid is written (see request_stop). The
  # FIFOs are opened by this subshell, never by PID 1 itself (see above).
  (devbox_exec $B sh -c 'echo $$ >'"$R"'/child.pid; if [ -e '"$R"'/stopping ]; then : >'"$R"'/nostart; exit 0; fi; exec "$@"' devbox-exec \
    $PRIV $B env -i "HOME=$U_HOME" "HOSTNAME=$DEVBOX_HOSTNAME" \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin") >"$R/out" 2>"$err_to"
  code=$?
fi
dbg "exited $code at $($B cut -d' ' -f1 /proc/uptime)"

# ------------------------------------------------------------ shutdown
# like Docker when a container's PID 1 exits: everything else gets SIGKILL
# (except the relays, which then drain their pipes and see EOF)
kill $helpers 2>/dev/null
for p in /proc/[0-9]*; do
  p=${p#/proc/}
  case " 1 2 $relays " in *" $p "*) continue ;; esac
  read -r _ _ _ pp _ 2>/dev/null <"/proc/$p/stat" || continue
  [ "$pp" = 2 ] || kill -KILL "$p" 2>/dev/null # ppid 2 = kernel thread
done
# relays end at EOF; give them 2 s in case a killed writer lingers
($B sleep 2; kill -KILL $relays 2>/dev/null) &
for p in $relays; do wait "$p" 2>/dev/null; done
dbg "relays done at $($B cut -d' ' -f1 /proc/uptime)"
$B sync
unmount_volumes
[ -e "$R/nostart" ] && marker NOSTART
marker "EXIT=$code"
# stty sets attributes with TCSADRAIN: returns once the console is drained
$B stty -F "$DEVBOX_TTY" -opost 2>/dev/null
$B poweroff -f
$B reboot -f
