' Launches glm-server-service.cmd with no visible console window (mode 0).
' Used as the action for the "GLM Server" scheduled task so the supervisor
' runs silently in the background at logon. Self-locating relative to this file.
Dim dir
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
CreateObject("WScript.Shell").Run """" & dir & "glm-server-service.cmd""", 0, False
