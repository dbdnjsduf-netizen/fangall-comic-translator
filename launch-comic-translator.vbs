Option Explicit

Dim shell, fso, baseDir, launcher
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = fso.BuildPath(baseDir, "launch-comic-translator.cmd")

shell.CurrentDirectory = baseDir
shell.Run Chr(34) & launcher & Chr(34), 1, False
