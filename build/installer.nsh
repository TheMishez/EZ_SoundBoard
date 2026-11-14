; EZ Soundboard installer hooks (electron-builder NSIS).
; One click: installs the app for all users, then turns EZ Soundboard on for the default
; microphone(s) - no VB-CABLE or other software needed.

!macro customInit
  ; Updating: Windows Audio may hold the old plugin DLL open, release it so files can be replaced.
  IfFileExists "$PROGRAMFILES64\EZ Soundboard\resources\driver\EZSoundboardApo.dll" 0 +2
    nsExec::Exec 'net stop audiosrv /y'
!macroend

!macro customInstall
  DetailPrint "Adding EZ Soundboard to your microphone..."
  nsExec::ExecToLog '"$INSTDIR\resources\driver\ezsb-mic-setup.exe" install default'
  Pop $0
  ; Make sure audio is running again even if the step above failed.
  nsExec::Exec 'net start audiosrv'
!macroend

!macro customUnInstall
  ; Skip during updates so the mics you picked stay enabled.
  ${ifNot} ${isUpdated}
    DetailPrint "Restoring your microphone..."
    nsExec::ExecToLog '"$INSTDIR\resources\driver\ezsb-mic-setup.exe" uninstall all --unregister'
    Pop $0
  ${endIf}
  nsExec::Exec 'net start audiosrv'
!macroend
