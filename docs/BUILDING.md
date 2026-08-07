# Building Casrion

Running from source is the same on both platforms. Building an **installer** is not, so this file splits by host OS.

The rule that catches everyone first: **you cannot build the macOS DMG on Windows, and you cannot build the Windows installer on macOS.** Electron apps have to be packaged on the OS they target. If you only have one machine, the GitHub Actions workflow at the bottom covers the other side.

---

## Before anything

```bash
npm install
```

Two dependencies ship native binaries and must not be rebuilt from source:

- `selection-hook`, which reads the selected text out of other applications
- `node-llama-cpp`, which runs the local model for the explain feature

Both ship prebuilt binaries for every platform we target, which is why `package.json` sets `"npmRebuild": false`. If you turn that off you will need a full native toolchain (Visual Studio Build Tools or Xcode) and the prebuilds can break. Leave it alone unless you know why you are changing it.

Both are also listed under `asarUnpack`, because native `.node` binaries cannot be loaded from inside an asar archive.

---

## Development

```bash
npm run dev      # Vite dev server + Electron together
npm run lint     # oxlint
```

`dev.cjs` starts Vite, waits for the port, then launches Electron pointed at it. The main process is loaded from `electron/` directly, so there is no obfuscation pass and stack traces are readable.

**On macOS**, the first `npm run dev` triggers permission prompts for Accessibility and Input Monitoring. macOS attributes those to the process that owns the build, so you will be granting them to **Terminal, iTerm or your editor**, not to an app called Casrion. That is expected in development. The packaged app asks for its own.

---

## Windows installer

```bash
npm run dist
```

That runs three steps: `vite build`, then `scripts/obfuscate.cjs`, then `electron-builder --win`.

Output: `%LOCALAPPDATA%\casrion-dist\Casrion-Setup-<version>.exe`

**Why the output is outside the project folder.** Antivirus and Windows Search index Desktop paths aggressively, and they race electron-builder's file renames, which shows up as spurious `EPERM` failures partway through packaging. Writing to `%LOCALAPPDATA%` avoids the race. If you move the project somewhere unindexed you can drop the `-c.directories.output` override.

**What you get:** an NSIS installer, x64 only. The `win.files` block excludes the CUDA and arm64 variants of `node-llama-cpp` and the non-Windows `selection-hook` prebuilds, which would otherwise add hundreds of megabytes of binaries nobody on that machine can run.

**Testing the packaged build** is worth doing before you release anything, because several classes of bug only appear once the code is inside an asar. Run the unpacked build directly:

```
%LOCALAPPDATA%\casrion-dist\win-unpacked\Casrion.exe
```

Check that global shortcuts still fire, that the whiteboard and quick input open, and that the explain model downloads to userData.

---

## macOS DMG

Requires a Mac with Apple Silicon, macOS 11 or newer, and Xcode command line tools.

```bash
npm run dist:mac
```

Output: `dist-electron/Casrion-<version>-arm64.dmg`

**Signing.** There is no Apple Developer certificate in this project, so `scripts/mac-adhoc-sign.cjs` runs as an `afterPack` hook and applies an ad-hoc signature (`codesign --sign -`). This is not cosmetic: Apple Silicon refuses to launch an app carrying no signature at all, so without this step the build packages fine and then dies instantly on launch. The hook verifies its own work with `codesign --verify` and fails the build if that does not pass.

Ad-hoc signed is not notarised, so users still need `xattr -cr /Applications/Casrion.app` on first run.

**Info.plist usage strings** are set through `mac.extendInfo` in `package.json`. macOS kills the app on the spot if it touches the microphone or sends an Apple Event without the matching usage string present, so if you add a capability that needs a permission, add its string at the same time.

**Testing the packaged build:** mount the DMG, drag the app to Applications, run the `xattr` command, then launch. Verify the tray icon appears, grant Accessibility and Input Monitoring when asked, and confirm the double-tap `Cmd` explain shortcut works. The permission prompts are the most common thing to break, and they cannot be tested from the unpacked build.

---

## Building the DMG without a Mac

`.github/workflows/mac-build.yml` builds the DMG on a macOS runner. Trigger it from the Actions tab or:

```bash
gh workflow run mac-build.yml
```

The DMG comes back as a workflow artifact. The workflow does more than build: it mounts the resulting DMG on the runner and verifies the things that are invisible from a Windows machine, since a DMG is a compressed disk image and you cannot inspect one after downloading it to a PC. It checks the binary is really arm64, that the ad-hoc signature satisfies its Designated Requirement, that both Info.plist usage strings survived, that every expected file made it into the asar, and that the native modules landed in `app.asar.unpacked` rather than inside the archive.

If you change what gets packaged, update that check. It exists because "the DMG is about the right size" is not verification.

---

## Releasing

1. Bump `version` in `package.json`.
2. Build both installers (Windows locally, macOS locally or through the workflow).
3. Upload them to a GitHub Release.
4. Update the version in `website/vercel.json`, which holds the `/get` and `/get-mac` redirects, then push.

**One trap worth knowing.** `gh release upload --clobber` deletes the existing asset before it uploads the new one. If the upload then times out, the release is left empty and every download link on the site is dead until you notice. Upload one asset at a time, and do not run it in a foreground shell with a short timeout.

---

## A note on the obfuscation step

`scripts/obfuscate.cjs` stages `electron/` into `electron-obf/` with the `.cjs` files obfuscated, and electron-builder packages that instead of the original. It predates this repo being public.

Now that the source is public it protects nothing, and it has a real cost: the shipped build no longer corresponds visibly to the source, so nobody can check that the binary they downloaded matches the code they just read. If you want reproducible, verifiable builds, drop the step from the `dist` scripts and point `build.files` at `electron` directly.
