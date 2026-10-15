#include "package-defines.iss"

[Setup]
AppId=Auto-cut
AppName=Auto-cut
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\Auto-cut
DefaultGroupName=Auto-cut
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.22000
OutputDir=installer
OutputBaseFilename=Auto-cut-{#AppVersion}-win-x64
Compression=lzma2
SolidCompression=yes
CloseApplications=no
RestartApplications=no
DisableProgramGroupPage=yes
WizardStyle=modern

[Files]
Source: "Auto-cut\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
#if PackageMode == "sea"
Name: "{group}\Auto-cut"; Filename: "{app}\Auto-cut.exe"; WorkingDir: "{app}"
#else
Name: "{group}\Auto-cut"; Filename: "{app}\resources\runtime\node.exe"; Parameters: """{app}\resources\host.cjs"""; WorkingDir: "{app}"
#endif

; No user-data deletion or forced process termination during uninstall.
