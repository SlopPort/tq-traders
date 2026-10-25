#!/system/bin/sh
# tq-traders: while tq-android-perf is installed and active, this service never injects (a second injection gets the
# game killed). tq-android-perf 2.3+ injects this module's tq-addon.js together with its own patches; older versions
# cannot, so update it or disable one of the two. Without an active tq-android-perf this service injects
# standalone.js once per game process.
MODDIR=${0%/*}
PERF=/data/adb/modules/tq_autopatch
umask 077
while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 3; done
if [ -f "$MODDIR/worker.pid" ]; then
 old=$(cat "$MODDIR/worker.pid")
 case "$old" in *[!0-9]*|'') ;; *)
  if [ -r "/proc/$old/cmdline" ] && tr '\000' ' ' < "/proc/$old/cmdline" | grep -Fq "$MODDIR/service.sh"; then exit 0; fi;;
 esac
fi
echo $$ > "$MODDIR/worker.pid"
trap 'rm -f "$MODDIR/worker.pid"' EXIT
perf_active() { [ -f "$PERF/service.sh" ] && [ ! -f "$PERF/disable" ] && [ ! -f "$PERF/remove" ] && [ ! -f "$PERF/paused" ]; }
last=''
while [ ! -f "$MODDIR/disable" ] && [ ! -f "$MODDIR/remove" ]; do
 if perf_active; then
  grep -q tq-addon.js "$PERF/service.sh" || echo 'tq-android-perf is too old to host add-ons: update it to 2.3+' > "$MODDIR/status.log"
  sleep 6; continue
 fi
 pid=$(pidof com.hg.titanquestultimate)
 case "$pid" in *[!0-9]*|'') sleep 4; continue;; esac
 start=$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null | cut -d' ' -f20)
 key="$pid:$start"
 if [ "$key" = "$last" ]; then sleep 4; continue; fi
 last="$key"
 if [ -f "$MODDIR/handled" ] && [ "$(cat "$MODDIR/handled")" = "$key" ]; then sleep 4; continue; fi
 # a perf module that is starting up may still take this process; give it a moment
 sleep 6
 if perf_active || [ -f "$PERF/handled" ] && [ "$(cat "$PERF/handled" 2>/dev/null)" = "$key" ]; then continue; fi
 echo "$key" > "$MODDIR/handled"
 echo "Injecting PID $pid" > "$MODDIR/status.log"
 "$MODDIR/injector" -p "$pid" -s "$MODDIR/standalone.js" -P '{"mode":"apply"}' -e >> "$MODDIR/status.log" 2>&1
 sleep 4
done
