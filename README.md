<div align="center">

<img src="public/logo.png" alt="Casrion" width="96">

# Casrion

**Take notes without leaving what you are reading.**

Casrion sits in your tray. You select something in any app, press one key, and it lands in a Markdown file with the page and the time already stamped on it. You never alt-tab, you never lose your place.

Windows 10/11 · macOS 11+ (Apple Silicon) · GPL-3.0 · no account, no telemetry, no cloud

[**Download**](https://casrion.com) · [Windows guide](https://casrion.com/windows) · [macOS guide](https://casrion.com/mac) · [Releases](https://github.com/DyneStein/Casrion/releases)

</div>

---

## Getting it

**Just want to use it?** Go to [casrion.com](https://casrion.com). It picks the right file for you.

**Rather grab the binary yourself?** The [Releases](https://github.com/DyneStein/Casrion/releases) tab has both:

| Platform | File | Notes |
|---|---|---|
| Windows 10/11, x64 | `Casrion-Setup-<version>.exe` | NSIS installer. SmartScreen will warn once, see below. |
| macOS 11+, Apple Silicon | `Casrion-<version>-arm64.dmg` | Unsigned, so it needs one command on first run, see below. |

Both installers are unsigned, because a code signing certificate costs more per year than this app earns, which is nothing. That is the only reason your OS complains.

<details>
<summary><b>Windows: getting past SmartScreen</b></summary>

Windows will say it protected your PC. Click **More info**, then **Run anyway**. It happens once. Nothing was scanned and flagged, Windows simply does not recognise the publisher name yet.
</details>

<details>
<summary><b>macOS: getting past Gatekeeper</b></summary>

The app is ad-hoc signed (which arm64 macOS requires to launch at all) but not notarised. After dragging it to Applications:

```bash
xattr -cr /Applications/Casrion.app
```

Then open it normally. Casrion will also ask for two permissions in System Settings > Privacy & Security:

- **Accessibility**, so it can read the text you have selected in other apps.
- **Input Monitoring**, so clicking away dismisses the explain popup. Optional: everything else works without it.

These are separate permissions and macOS grants them separately. The [macOS guide](https://casrion.com/mac) walks through it with screenshots.
</details>

---

## What it actually does

Every shortcut below is global. They work while you are in Chrome, a PDF, Word, a terminal, anywhere. `CommandOrControl` means `Ctrl` on Windows and `Cmd` on macOS.

**Copy something first, then press:**

| | Windows | macOS |
|---|---|---|
| Keep it as it is | `Ctrl Shift C` | `Cmd Shift C` |
| Keep it as a heading | `Ctrl Shift 1` / `2` / `3` | `Cmd Shift 1` / `2` / `3` |
| Keep it as code | `Ctrl Shift K` | `Cmd Shift K` |
| Keep it bold / italic | `Ctrl Shift B` / `I` | `Cmd Shift B` / `I` |
| Keep it coloured | `Alt R` / `G` / `B` | `Alt R` / `G` / `B` |

**Nothing to copy:**

| | Windows | macOS |
|---|---|---|
| Drop in a screenshot | `Ctrl Shift V` | `Cmd Shift V` |
| Start or stop a voice memo | `Ctrl Shift M` | `Cmd Shift M` |
| Open a whiteboard and draw | `Ctrl Shift D` | `Cmd Shift D` |
| Type a quick note from anywhere | `Ctrl Shift Q` | `Cmd Shift Q` |
| New paragraph | `Ctrl Shift N` | `Cmd Shift N` |
| Undo / redo the last capture | `Ctrl Shift Z` / `Y` | `Cmd Shift Z` / `Y` |
| Show every shortcut | `Ctrl Shift H` | `Cmd Shift H` |

**Explain a selection.** Highlight anything, press `Ctrl+Shift+E` (`Cmd+Shift+E` on macOS), and a small window tells you what it says. It OCRs the screen around your selection first, so it knows a loose symbol belongs to the formula three lines up. Runs on a local model, so it works on a plane and nothing you highlight leaves the machine.

---

## Your notes are just files

This is the part that matters most and the reason the app is worth trusting.

```
YourNotesFolder/
├── Thermodynamics.md          <- plain Markdown, open it in anything
├── Reading list.md
└── assets/
    ├── screenshot-1712...png  <- referenced from the .md as ./assets/...
    ├── memo-1712....webm
    └── board-1712....svg
```

No database, no proprietary format, no lock-in. Put the folder in Dropbox, in git, in Obsidian, it all just works. If Casrion disappeared tomorrow your notes would be exactly as readable as they are today.

**Safe to do:** rename a note, move the whole folder, edit in another editor, sync it anywhere.
**Breaks links:** renaming or moving anything inside `assets/` without updating the `.md` that points at it.

---

## Privacy

There is no account, no telemetry, no analytics and no update check. The app makes exactly one network request in its entire life: downloading the local AI model, once, and only if you choose to use the explain feature. Fonts are self-hosted. Nothing else ever leaves your machine.

---

## Running from source

You need [Node.js](https://nodejs.org) 20 or newer and git.

```bash
git clone https://github.com/DyneStein/Casrion.git
cd Casrion
npm install
npm run dev      # Vite dev server + Electron, with hot reload
npm run lint     # oxlint
```

`npm run dev` works the same on Windows and macOS. On macOS the first launch will prompt for Accessibility and Input Monitoring, and it prompts for *your terminal or editor*, not for Casrion, because that is the process that owns the dev build.

Building the installers is platform-specific and has a few traps, so it lives in **[docs/BUILDING.md](docs/BUILDING.md)**.

If you want to understand the codebase before changing it, start with **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Repo layout

```
├── electron/       main process: window management, global shortcuts,
│                   capture pipeline, explain, OCR, local model, whiteboard
├── src/            React renderer: editor, viewer, sidebar, help panel
├── build/          installer icons and NSIS resources
├── scripts/        build helpers (obfuscation pass, macOS ad-hoc signing)
├── website/        casrion.com, a static site with no build step
└── .github/        the macOS DMG build workflow
```

---

## Contributing

Issues and pull requests are welcome. A few things worth knowing before you open one:

- Global shortcuts are the whole product, so anything that changes a keybinding needs a good reason and needs testing on both platforms.
- The macOS and Windows paths genuinely diverge (permissions, menu key equivalents, selection reading). If you touch one, say in the PR whether you tested the other.
- Keep the app dependency-light and offline. A PR that adds a network call needs to justify it.
- The macOS DMG can only be built on macOS. There is a GitHub Actions workflow for it if you do not have a Mac.

---

## Licence

[GPL-3.0](LICENSE). You can read it, run it, fork it and ship it. If you distribute a modified version, that version has to stay open source too.

Built by [DyneStein](https://github.com/DyneStein). Something broken? Open an issue or email hello@casrion.com.
