; Windows Firewall rule so student agents can connect to the teacher console.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ClassMonitor Teacher"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="ClassMonitor Teacher" dir=in action=allow protocol=TCP localport=47801 program="$INSTDIR\ClassMonitor Teacher.exe" profile=domain,private'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ClassMonitor Teacher"'
!macroend
