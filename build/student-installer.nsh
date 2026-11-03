; Windows Firewall rule so the agent can hear the teacher's discovery beacons.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ClassMonitor Student discovery"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="ClassMonitor Student discovery" dir=in action=allow protocol=UDP localport=47800 program="$INSTDIR\ClassMonitor Student.exe" profile=domain,private'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ClassMonitor Student discovery"'
!macroend
