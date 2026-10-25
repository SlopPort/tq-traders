# Third-party components

- **Frida** (`frida-inject`, CModule): https://frida.re, licensed under the wxWindows Library Licence 3.1.
  The installable zip bundles the unmodified `frida-inject` binary for android-arm64 from the official release
  (`module/build.py` downloads it).
- **tq-android-perf** menu core (`overlay.c`, `overlay-glue.js` and helpers, MIT, same contributors): included in
  `module/standalone.js` for use without tq-android-perf.
- **Aileron** font (Sora Sagano, public domain), bundled with Pillow: the menu's glyph atlas is rendered from it.
- **Magisk module installer** (`module/META-INF/com/google/android/update-binary`): the standard module installer
  script from the Magisk documentation.
- **Titan Quest** is a trademark of THQ Nordic. This project is an unofficial, non-commercial fan project. It is not
  affiliated with or endorsed by THQ Nordic or HandyGames. It contains no game files, game code or assets: the module
  changes the user's own installed copy in memory, and the item list is built on the device from the user's own copy.
