; Arena: optionales KI-Modell Laya (src-tauri/src/laya.rs) im Installer.
;
; - Willkommensseite: Haken "Laya: KI fuer Schlagzeilen", standardmaessig gesetzt. (MUI_PAGE_CUSTOMFUNCTION_SHOW
;   gilt fuer die naechste MUI-Seite, und die erste im Tauri-Template ist die Willkommensseite; deren Text endet
;   bei 175u, der Haken steht darunter.)
; - Nach der Installation: Auswahl nach %LOCALAPPDATA%\<id>\laya-choice ("1"/"0"). Arena uebernimmt sie beim
;   Start und laedt das Modell (~310 MB, geprueft) im Hintergrund. Updates (/UPDATE) lassen die Auswahl in Ruhe;
;   eine stille Erstinstallation (/P) nimmt die Vorgabe (mit Modell).
; - Deinstallation (nicht bei Updates): Modellordner und Auswahl loeschen.
; In den Einstellungen der App laesst sich das Modell jederzeit installieren oder entfernen.

!include nsDialogs.nsh
!include LogicLib.nsh

Var LayaCheckbox
; "" = noch nicht angefasst (= mit Modell), "1" an, "0" aus
Var LayaWant

!define MUI_PAGE_CUSTOMFUNCTION_SHOW LayaWelcomeShow

Function LayaWelcomeShow
  ${NSD_CreateCheckbox} 120u 177u 195u 13u "Laya: KI für Schlagzeilen (lädt ca. 310 MB)"
  Pop $LayaCheckbox
  SetCtlColors $LayaCheckbox "000000" "FFFFFF"
  ${If} $LayaWant == "0"
    ${NSD_Uncheck} $LayaCheckbox
  ${Else}
    ${NSD_Check} $LayaCheckbox
  ${EndIf}
  ${NSD_OnClick} $LayaCheckbox LayaToggle
FunctionEnd

Function LayaToggle
  Pop $0
  ${NSD_GetState} $LayaCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $LayaWant "1"
  ${Else}
    StrCpy $LayaWant "0"
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  ${If} $UpdateMode <> 1
    CreateDirectory "$LOCALAPPDATA\${BUNDLEID}"
    FileOpen $0 "$LOCALAPPDATA\${BUNDLEID}\laya-choice" w
    ${If} $LayaWant == "0"
      FileWrite $0 "0"
    ${Else}
      FileWrite $0 "1"
    ${EndIf}
    FileClose $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    RMDir /r "$LOCALAPPDATA\${BUNDLEID}\laya"
    Delete "$LOCALAPPDATA\${BUNDLEID}\laya.json"
    Delete "$LOCALAPPDATA\${BUNDLEID}\laya-choice"
  ${EndIf}
!macroend
