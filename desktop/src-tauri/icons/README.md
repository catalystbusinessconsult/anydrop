No icon assets generated yet — `tauri.conf.json` references
`32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.ico`, and `tray.png`
here, none of which exist, so a real `tauri build`/`tauri dev` will fail
until they're added.

Once there's a source app icon (1024x1024 PNG recommended) and the Tauri
CLI is installed (see `desktop/README.md`), generate the full set with:

```bash
npm run tauri icon path/to/source-icon.png
```

That produces every size Tauri's bundler expects. `tray.png` (the
menu-bar/system-tray glyph, `iconAsTemplate: true` in `tauri.conf.json` so
it should be a simple monochrome shape) needs to be added separately —
`tauri icon` doesn't generate it.
