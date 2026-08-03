Option Explicit

Dim shell, fso, baseDir, url, nodeCheck, killCmd, killOauthCmd, shutdownCmd, serverCmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://127.0.0.1:3344"

shell.CurrentDirectory = baseDir

On Error Resume Next
nodeCheck = shell.Run("node -v", 0, True)
If Err.Number <> 0 Then
  MsgBox "Node.js를 찾을 수 없습니다.", vbCritical, "Comic Translator"
  WScript.Quit 1
End If
Err.Clear
On Error GoTo 0

shutdownCmd = "powershell -NoProfile -Command ""try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3344/api/shutdown | Out-Null } catch {}"""
killCmd = "powershell -NoProfile -Command ""$p = Get-NetTCPConnection -LocalPort 3344 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { Stop-Process -Id $p.OwningProcess -Force }"""
killOauthCmd = "powershell -NoProfile -Command ""Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 10531 -and $_.LocalPort -le 10545 } | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"""

On Error Resume Next
shell.Run shutdownCmd, 0, True
shell.Run killCmd, 0, True
shell.Run killOauthCmd, 0, True
On Error GoTo 0

serverCmd = "cmd /c cd /d " & Chr(34) & baseDir & Chr(34) & " && node server.mjs > translator-server.log 2>&1"
shell.Run serverCmd, 0, False
WScript.Sleep 5000
shell.Run Chr(34) & url & Chr(34), 1, False
