Option Explicit

Dim shell, fso, baseDir, shutdownCmd, killOauthCmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
shutdownCmd = "powershell -NoProfile -Command ""try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3344/api/shutdown | Out-Null } catch {}"""
killOauthCmd = "powershell -NoProfile -Command ""Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 10531 -and $_.LocalPort -le 10545 } | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"""

shell.CurrentDirectory = baseDir
shell.Run shutdownCmd, 0, True
shell.Run killOauthCmd, 0, True
WScript.Sleep 1500
shell.Run Chr(34) & fso.BuildPath(baseDir, "launch-comic-translator.vbs") & Chr(34), 0, False
