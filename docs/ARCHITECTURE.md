# How Casrion is put together

About 7,500 lines across a main process and a React renderer. This is the map you want before changing anything.

---

## The one rule

**All state lives in the main process.** The active file, the current insertion line, the per-file undo stack: all of it is in `electron/main.cjs`. The renderer is a view.

This is not the usual Electron arrangement, and it is deliberate. Captures arrive from global shortcuts while the window is closed or hidden, so the renderer cannot be the source of truth for where the next line goes. If you find yourself adding note state to React, you are probably fighting the design.

Every IPC handler returns `buildStatePayload()`, and captures broadcast on the `file-updated` channel. The renderer re-renders from whatever it is handed.

---

## Layout

```
electron/
  main.cjs                2620 lines. Windows, tray, global shortcuts, the capture
                          pipeline, file and folder management, undo, settings.
  explain.cjs              708. Selection reading, the explain overlay, prompt assembly.
  llm.cjs                  257. Model download and node-llama-cpp lifecycle.
  ocr.cjs                  155. Screen-region OCR. Windows only, see below.
  capture-normalize.cjs    247. HTML clipboard to clean Markdown.
  webm-duration.cjs        192. Writes real duration into recorded WebM.
  preload.cjs               63. The bridge for the main window.

  board.html               508. The whiteboard, self-contained.
  explain-overlay.html     447. The explain popup.
  help-overlay.html        208. The shortcut sheet.
  quick-input.html         183. Type-a-note-from-anywhere.
  overlay.html             119. Capture confirmation toasts.

src/
  Viewer.jsx               635. Rendered Markdown, KaTeX math.
  Editor.jsx               551. The editing surface.
  App.jsx                  369. Renderer state, routing, IPC wiring.
  HelpPanel.jsx            198.
  Sidebar.jsx              114. Folders and files.
```

The standalone HTML files are a pattern, not an accident. Each overlay is its own frameless `BrowserWindow` loading a single file with `nodeIntegration: true` and no build step. They need to appear in under 150ms over whatever the user is looking at, so they are pre-created hidden at startup and shown on demand. Routing them through the React app would cost a bundle load and a window paint.

---

## The capture pipeline

1. A global shortcut fires in `registerShortcuts()` (`main.cjs`, around line 1856).
2. The clipboard is read. If it holds HTML, `capture-normalize.cjs` runs it through turndown to get clean Markdown instead of a wall of markup.
3. Source info is gathered: foreground window title, app name, and the browser URL if the front app is a browser.
4. The block is written into the active `.md` at the current insertion line, and assets are written to `assets/` beside it.
5. An overlay toast confirms, and `file-updated` goes out to the renderer.

Captures are queued (`enqueueCapture`) rather than run concurrently, because two shortcuts pressed quickly would otherwise race on the same insertion line.

**Source stamping** is platform-split. On Windows a persistent PowerShell helper answers title and URL queries over stdio. On macOS the app name comes from the running-application API and the browser URL comes from AppleScript, which is why the DMG declares `NSAppleEventsUsageDescription`.

---

## Notes on disk

Plain Markdown in folders the user picks, with binary assets in an `assets/` folder alongside. No database, no index, no proprietary container.

Content is **hydrated** before it reaches the renderer: relative `./assets/...` paths in the file are rewritten to `casrion://` URLs so Chromium will load them, and dehydrated on the way back to disk. A file on disk never contains a `casrion://` URL.

The `casrion://` protocol handler refuses to serve anything outside a registered workspace folder. That check is the only thing standing between a crafted note and arbitrary local file reads, so treat it as security-critical.

---

## The explain feature

Select text anywhere, press `Ctrl+Shift+E` (`Cmd+Shift+E` on macOS), get a local model's explanation in a popup near the selection.

- **Reading the selection** uses `selection-hook`, a native module that goes through the platform accessibility APIs. The clipboard fallback that library offers is **deliberately disabled**: it simulates Ctrl+C, which empties whatever the user actually had on their clipboard, including screenshots. Do not turn it back on.
- **The overlay shows first, then the work starts.** It is pre-created and shown with `showInactive()` so the user's app keeps focus and their selection stays highlighted.
- **Context radius, Windows only.** `ocr.cjs` screenshots a region around the selection and OCRs it through the built-in `Windows.Media.Ocr` WinRT API, driven from a persistent PowerShell process. This is what lets the model know a stray symbol belongs to the formula three lines above it. There is no macOS equivalent wired up, so on macOS the model gets the selection plus window title and URL, and explanations of formulas in PDFs are correspondingly weaker. This is the most obvious open contribution in the codebase.
- **The model** is Qwen3-1.7B (Q4_K_M GGUF, about 1.1GB), downloaded on first use into userData, never bundled. `llm.cjs` keeps one context warm between requests so the system prompt stays prefix-cached, and unloads after an idle period because the model is most of the app's resident memory.
- **Dismissal is platform-split.** On Windows the global mouse hook detects clicks outside the popup. On macOS that hook needs Input Monitoring, which is a *different* permission from the Accessibility one the rest of the feature uses, so there is a permission-free fallback that watches `NSWorkspaceDidActivateApplicationNotification`. If the popup detects it has no click-away signal at all, it offers a button that opens the exact settings pane.

---

## Platform divergence

The two platforms differ more than you would guess. The places that actually bite:

| | Windows | macOS |
|---|---|---|
| Selection reading | UI Automation | Accessibility permission |
| Click-away detection | global mouse hook | Input Monitoring, or NSWorkspace fallback |
| Browser URL | PowerShell helper | AppleScript, needs Apple Events consent |
| Screen OCR | `Windows.Media.Ocr` | not implemented |
| Menu key equivalents | window-local | **app-global, and matched before the page sees the key** |

That last row caused a real bug worth knowing about. macOS puts one menu bar at the top of the screen for the whole app and matches its key equivalents *before* a keystroke reaches any page. Electron's stock Edit menu therefore ate `Cmd+Z` in the whiteboard, and `Cmd+R` would reload a window and throw a drawing away. `setBoardMenuKeysFree()` in `main.cjs` disables those specific menu roles while the board holds focus and restores them on blur. Disabled items do not claim their key equivalent, which is what makes the trick work.

---

## Things that will surprise you

- **The whiteboard canvas is device-pixel scaled.** Two canvases (a live plate and a baked layer) sized to `W * dpr` with a `setTransform(dpr, ...)`. Anything drawing the baked canvas onto the plate must pass explicit destination dimensions, because the source is in device pixels and the destination context is transformed.
- **Recorded WebM has no duration header.** Chromium's MediaRecorder writes an unknown duration, and the old workaround (seeking past the end to force the player to discover it) provoked a range request the browser treats as fatal. `webm-duration.cjs` writes the real length into the container instead.
- **`npmRebuild` is off on purpose.** See [BUILDING.md](BUILDING.md).
- **Shipped builds are obfuscated.** `scripts/obfuscate.cjs` runs before packaging, so the code in a release does not visibly match the code in this repo. That made sense when the source was closed. It does not any more, and BUILDING.md explains how to remove it.
