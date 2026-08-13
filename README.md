<div align="center">

<img src="public/logo.png" alt="Casrion" width="96">

# Casrion

**Take notes without leaving what you are reading.**

Casrion sits in your tray. You select something in any app, press one key, and it lands in a Markdown file with the page and the time already stamped on it. You never alt-tab, you never lose your place.

### [Download for Windows](https://casrion.com/get) &nbsp;·&nbsp; [Download for Mac](https://casrion.com/get-mac)

Those two links start the download straight away. No sign up, no account, no email.

Windows 10/11 · macOS 11+ (Apple Silicon) · GPL-3.0 · no telemetry, no cloud

[casrion.com](https://casrion.com) · [Windows guide](https://casrion.com/windows) · [macOS guide](https://casrion.com/mac) · [All releases](https://github.com/DyneStein/Casrion/releases)

</div>

---

## Installing it

Run the file you downloaded. That is the whole thing. But both installers are unsigned, because a code signing certificate costs more per year than this app earns, which is nothing, so each OS complains once before it lets you through.

**Windows.** SmartScreen will say it protected your PC. Click **More info**, then **Run anyway**. Nothing was scanned and flagged. Windows simply does not recognise the publisher name yet.

**macOS.** Drag it to Applications, then open Terminal and paste this one line:

```bash
xattr -cr /Applications/Casrion.app
```

Then open it normally. macOS will also ask for **Accessibility** in System Settings > Privacy & Security, which is how Casrion reads the text you have selected in other apps. **Input Monitoring** is optional: without it everything works, you just have to close the explain popup with its own button instead of by clicking away.

One macOS thing that catches people out on every update. Because there is no Apple certificate, the permission you granted is tied to that exact copy of the app, so a new version does not inherit it. System Settings will keep showing the switch as on while it has quietly stopped applying, and toggling it does nothing. Select Casrion in the list, remove it with the minus button, add it back with plus, then quit and reopen. Casrion notices this itself now and tells you.

The [macOS guide](https://casrion.com/mac) walks through all of it with screenshots.

---

## The keys

Every shortcut is global. They work while you are in Chrome, a PDF, Word, a terminal, anywhere. You never have to bring Casrion to the front.

**Copy something first, then press:**

| | Windows | macOS |
|---|---|---|
| Keep it as it is | `Ctrl` `Shift` `C` | `Cmd` `Shift` `C` |
| Keep it as a heading | `Ctrl` `Shift` `1` / `2` / `3` | `Cmd` `Shift` `1` / `2`, `Cmd` `Ctrl` `3` |
| Keep it as code | `Ctrl` `Shift` `K` | `Cmd` `Shift` `K` |
| Keep it bold / italic | `Ctrl` `Shift` `B` / `I` | `Cmd` `Shift` `B` / `I` |
| Keep it coloured | `Alt` `R` / `G` / `B` | `Cmd` `Ctrl` `R` / `G` / `B` |

**Nothing to copy:**

| | Windows | macOS |
|---|---|---|
| Explain what I selected | `Ctrl` `Shift` `E`, or tap `Ctrl` twice | `Cmd` `Shift` `E` |
| Drop in a screenshot | `Ctrl` `Shift` `V` | `Cmd` `Shift` `V` |
| Start or stop a voice memo | `Ctrl` `Shift` `M` | `Cmd` `Shift` `M` |
| Open a whiteboard and draw | `Ctrl` `Shift` `D` | `Cmd` `Shift` `D` |
| Type a quick note from anywhere | `Ctrl` `Shift` `Q` | `Cmd` `Shift` `J` |
| New paragraph | `Ctrl` `Shift` `N` | `Cmd` `Shift` `N` |
| Undo / redo the last capture | `Ctrl` `Shift` `Z` / `Y` | `Cmd` `Shift` `Z` / `Y` |
| Show every shortcut | `Ctrl` `Shift` `H` | `Cmd` `Shift` `H` |

Three of the Mac ones look like typos and are not. `Cmd+Shift+3` is the system screenshot, `Cmd+Shift+Q` is Log Out, and `Option+R/G/B` type special characters. macOS will not let an app override any of them, so heading 3, quick note and the colours moved out of the way. Press `Cmd+Shift+H` any time and the app will tell you what its own keys are.

---

## Explaining things you do not understand

Highlight anything, press `Ctrl+Shift+E` (`Cmd+Shift+E` on a Mac), and a small window tells you what it says, right where you are standing. It OCRs the screen around your selection first, so it knows a loose symbol belongs to the formula three lines up.

On Windows you can also just tap `Ctrl` twice. It only counts when Ctrl goes down and back up with nothing pressed in between, so copying and pasting never sets it off by accident. That gesture is Windows only: watching for it on a Mac needs Input Monitoring, a permission most people never grant, and when it is missing the gesture fails silently with nothing to tell you why.

This runs on a model that lives on your machine. The first time you use it, Casrion downloads that model once, about 1.1 GB, and after that it works on a plane. Nothing you highlight ever leaves the computer.

On macOS, Safari is the one place this cannot work. Safari does not expose page text to other apps through the accessibility system, so there is genuinely nothing to read. Chrome, TextEdit, Notes, Preview and PDFs are all fine, and the popup tells you which case you are in instead of leaving you guessing.

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

`npm run dev` works the same on Windows and macOS. On macOS the first launch will prompt for Accessibility, and it prompts for *your terminal or editor*, not for Casrion, because that is the process that owns the dev build.

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
