"""Build the tq-traders Magisk module (traders + respec add-on for Titan Quest on Android).

Two ways it runs, always as one injection per game process:
  - with tq-android-perf (2.3+) installed: that module's service appends this module's tq-addon.js to its own script;
    this module's service stays idle;
  - alone: this module's service injects standalone.js = the overlay core from tq-android-perf (menu drawing, touch,
    font; no engine patches) + the add-on.

The menu core (overlay.c, overlay-glue.js, font) and a few base helpers come from a tq-android-perf (2.3+) checkout:
its module/patch.js and module/src/.

  python src/build_module.py --perf ../tq-android-perf     -> module/tq-addon.js, module/standalone.js, module/service.sh
"""
import argparse, pathlib, re

HERE = pathlib.Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument('--perf', default=str(HERE.parent.parent / 'tq-android-perf'), help='tq-android-perf checkout')
ap.add_argument('--out', default=str(HERE.parent / 'module'))
a = ap.parse_args()
PERF = pathlib.Path(a.perf)
OUT = pathlib.Path(a.out)
VERSION, CODE = '1.4', 5

perf = (PERF / 'module' / 'patch.js').read_text(encoding='utf-8')
assert 'OVERLAY_ADDONS' in perf, 'tq-android-perf 2.3+ needed'


def top_level(name):
    """One top-level definition (function / const / assignment) from the perf module's patch.js."""
    m = re.search(r'^(?:async function|function|const|let|var) ' + re.escape(name) + r'\b|^' + re.escape(name) + r' = ', perf, re.M)
    assert m, name
    lines, out = perf[m.start():].split('\n'), []
    for i, line in enumerate(lines):
        if i > 0 and line and not line[0].isspace() and not line.startswith('}') and not line.startswith(')'):
            break
        out.append(line)
    return '\n'.join(out).rstrip() + '\n'


base = ''.join(top_level(n) for n in ['held', 'clean', 'V2_CACHE', 'V2', 'v2Save', 'v2Set', 'v2Sleep', 'V2.exp',
                                         'v2Elf', 'v2BuildId', 'v2Imports', 'v2WaitEngine'])
base = base.replace("status: { module: '2.0',", "status: { module: 'tq-traders " + VERSION + "',")

trader_c = (HERE / 'trader.c').read_text(encoding='utf-8')
overlay_c = (PERF / 'module' / 'src' / 'overlay.c').read_text(encoding='utf-8')
for c in (trader_c, overlay_c):
    assert '`' not in c and '${' not in c
addon = ('// tq-traders ' + VERSION + ' add-on: traders (green / blue / purple) and respec. Contains no game code.\n'
         'const TRADER_C = `\n' + trader_c + '`;\n' + (HERE / 'trader-glue.js').read_text(encoding='utf-8'))

init = r'''
rpc.exports.init = async function (stage, p) {
  try {
    const m = await v2WaitEngine();
    V2.mod = m;
    V2.status.buildId = v2BuildId(m.base, v2Elf(m.base));
    V2.imp = v2Imports(m.base);
    v2Set('menu', Object.assign({ state: 'active' }, overlayInstall(m.base, {}, { perfRows: false, label: 'Mods' })));
    v2Save();
  } catch (e) { console.log('TQ_ERROR ' + String(e)); }
};
'''
standalone = ('// tq-traders ' + VERSION + ' (standalone): overlay core from tq-android-perf + the traders add-on.\n'
              '// Contains no game code: functions are resolved by exported name.\n'
              + base + top_level('OV_FONT')
              + 'const OVERLAY_C = `\n' + overlay_c + '`;\n'
              + (PERF / 'module' / 'src' / 'overlay-glue.js').read_text(encoding='utf-8') + addon + init)

service = r'''#!/system/bin/sh
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
 # tq_mods (Titan Quest Mods loader) injects this module's scripts in its own single injection: stand back.
 M=/data/adb/modules/tq_mods
 if [ -f "$M/service.sh" ] && [ ! -f "$M/disable" ] && [ ! -f "$M/remove" ]; then sleep 4; continue; fi
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
'''
prop = f'''id=tq_traders
name=TQ Traders & Respec (unofficial)
version={VERSION}
versionCode={CODE}
author=tq-android-perf contributors
description=Titan Quest (Android, arm64): summon green (gold), blue and purple (paid with items of that color) traders with items up to your level, restock any merchant, reset skills (choose masteries again) and attributes. Menu: Perf (with tq-android-perf) or Mods button. Works alone or as an add-on of tq-android-perf (one injection either way).
'''
OUT.mkdir(exist_ok=True)
for name, text in {'tq-addon.js': addon, 'standalone.js': standalone, 'service.sh': service, 'module.prop': prop}.items():
    (OUT / name).write_text(text, encoding='utf-8', newline='\n')
print('built', OUT, {n: (OUT / n).stat().st_size for n in ('tq-addon.js', 'standalone.js')})
