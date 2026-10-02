; Church Work Space — installer/uninstaller extras.
;
; The Social Scheduler can ask Windows to run this app every few minutes with
; --publish-due so that scheduled posts go out with the app closed (see
; src/main/autopost.js). That task is registered outside the app's own folder,
; so uninstalling has to take it away as well — otherwise Windows keeps trying
; to start an exe that is no longer there, every five minutes, forever.
;
; The task may well not exist; /F makes a missing one a no-op and the return
; code is ignored either way, so this can never block an uninstall.

!macro customUnInstall
  ExecWait 'schtasks.exe /Delete /TN "Church Work Space Auto-Post" /F'
!macroend
