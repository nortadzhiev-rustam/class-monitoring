; Student installer additions: firewall rule, the IT config folder, and
; stopping the agent so installs and uninstalls never wait for it.

; The agent has no Quit item, so nobody can "close it and retry" when the stock
; check finds it running. Stop every copy instead (/F force, /T with its helper
; processes), twice, since Chrome or Edge can restart it straight away as the
; web filter's native-messaging host. Run before elevation it can only stop the
; current user's copy; customUnInstall repeats it with admin rights.
!macro customCheckAppRunning
  Push $0
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 1000
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 500
  Pop $0
!macroend

!macro customInstall
  Push $0
  ; Windows Firewall rule so the agent can hear the teacher's discovery beacons.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ClassMonitor Student discovery"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall add rule name="ClassMonitor Student discovery" dir=in action=allow protocol=UDP localport=47800 program="$INSTDIR\ClassMonitor Student.exe" profile=domain,private'
  Pop $0
  ; C:\ProgramData\ClassMonitor, where IT puts student.json. Students may read it
  ; but not create or change it (any user could otherwise create this folder and
  ; point the agent at their own "teacher"). SIDs keep it language-independent:
  ; SYSTEM, Administrators full control; Users read.
  ReadEnvStr $0 PROGRAMDATA
  CreateDirectory "$0\ClassMonitor"
  nsExec::Exec 'icacls "$0\ClassMonitor" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)RX'
  Pop $0
  Pop $0
!macroend

!macro customUnInstall
  ; Now with admin rights: stop the agent in every user's session before its files go.
  !insertmacro customCheckAppRunning
  Push $0
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ClassMonitor Student discovery"'
  Pop $0
  ; Keep a student.json IT deployed (for a reinstall); remove the folder only if it's empty.
  ReadEnvStr $0 PROGRAMDATA
  RMDir "$0\ClassMonitor"
  Pop $0
!macroend
