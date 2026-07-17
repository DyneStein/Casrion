# Casrion

Background note-taker for Windows. Casrion sits in your tray while you study or research; global hotkeys capture clipboard text, screenshots, code blocks and voice memos straight into plain Markdown files — without ever switching windows.

![logo](public/logo.png)

## Development

```
npm install
npm run dev        # Vite dev server + Electron
npm run lint       # oxlint
```

## Building the installer

```
npm run dist
```

The NSIS installer is written to `%LOCALAPPDATA%\casrion-dist\Casrion-Setup-<version>.exe`.
(Output goes outside the project folder because antivirus/indexing on Desktop paths races
electron-builder's file renames and causes spurious EPERM failures.)

- App source is packed into `app.asar`; the renderer is minified by Vite.
- Runtime icons live in `electron/icons/`; installer/window icon sources in `build/` (`icon.ico`, `icon.png` master).
- Fonts are self-hosted in `src/assets/fonts` — the app makes no network requests.

## Publishing

See `website/` for the landing page and `website/DEPLOYMENT.md` for the free hosting setup
(GitHub Releases for the installer + Cloudflare/GitHub Pages for the site + custom domain).

## Architecture notes

- `electron/main.cjs` — all state lives in the main process (active file, insertion line, per-file undo).
  Every IPC handler returns `buildStatePayload()` and captures broadcast on the `file-updated` channel;
  note content is always "hydrated" (relative `assets/...` → `casrion://` URLs) before reaching the renderer.
- `casrion://` protocol only serves files inside workspace folders.
- `src/App.jsx` owns renderer state; editor saves are debounced with a flush before any file switch.
