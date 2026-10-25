[ "$ARCH" = arm64 ] || abort "This module needs an arm64 (64-bit ARM) Android device"
set_perm_recursive "$MODPATH" 0 0 0755 0644
set_perm "$MODPATH/injector" 0 0 0700
set_perm "$MODPATH/service.sh" 0 0 0700
ui_print "- Start Titan Quest and open the Mods menu (or the Perf menu with tq-android-perf 2.3+)."
ui_print "- With tq-android-perf installed, that module loads this one: only one injection per game process."
