!macro customHeader
  BrandingText "Casrion Setup"
!macroend

; The finish page, identical to electron-builder's stock one (templates/nsis/
; assistedInstaller.nsh) except for one line: HideWindow before the launch.
;
; With "Run Casrion" ticked, Finish launches the app through ExecShellAsUser,
; which waits until Windows has actually started the process. On a first
; install that wait is long: the antivirus scans a brand new, unsigned ~200MB
; executable before letting it run. All that time the installer sat on screen
; frozen and marked "Not Responding", which looked like a crash. Hiding it
; first means the window goes away the moment Finish is clicked; the launch
; itself is unchanged, and the installer exits as soon as it returns.
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      HideWindow
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !insertmacro MUI_PAGE_FINISH
!macroend
