; marohwp — NSIS 추가 스크립트 (electron-builder 가 설치/제거 스크립트에 끼워 넣는다)
;
; 목적: .hwp / .hwpx 의 "연결 프로그램" 목록에 marohwp 를 추가한다.
;       사용자의 기본 연결 프로그램(예: 한컴 한글)은 건드리지 않는다.
;
;  - 모든 항목은 현재 사용자(HKCU)에만 쓴다. 관리자 권한이 필요 없다.
;  - .hwp / .hwpx 키의 기본값(기본 ProgID)과 UserChoice 는 쓰지 않는다.
;  - 제거할 때는 여기서 만든 키/값만 지운다.
;
; 이 파일은 UTF-8 이다 (electron-builder 가 makensis 를 -INPUTCHARSET UTF8 로 실행한다).

!define MAROHWP_CLASSES "Software\Classes"
!define MAROHWP_PROGID_HWP "marohwp.hwp"
!define MAROHWP_PROGID_HWPX "marohwp.hwpx"
!define MAROHWP_APP_KEY "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"

!macro customInstall
  ; ProgID: marohwp.hwp
  WriteRegStr HKCU "${MAROHWP_CLASSES}\${MAROHWP_PROGID_HWP}" "" "한글 문서 (HWP)"
  WriteRegStr HKCU "${MAROHWP_CLASSES}\${MAROHWP_PROGID_HWP}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "${MAROHWP_CLASSES}\${MAROHWP_PROGID_HWP}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; ProgID: marohwp.hwpx
  WriteRegStr HKCU "${MAROHWP_CLASSES}\${MAROHWP_PROGID_HWPX}" "" "한글 표준 문서 (HWPX)"
  WriteRegStr HKCU "${MAROHWP_CLASSES}\${MAROHWP_PROGID_HWPX}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "${MAROHWP_CLASSES}\${MAROHWP_PROGID_HWPX}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; "연결 프로그램" 후보로만 등록 (기본 프로그램은 바꾸지 않는다)
  WriteRegStr HKCU "${MAROHWP_CLASSES}\.hwp\OpenWithProgids" "${MAROHWP_PROGID_HWP}" ""
  WriteRegStr HKCU "${MAROHWP_CLASSES}\.hwpx\OpenWithProgids" "${MAROHWP_PROGID_HWPX}" ""

  ; Applications\marohwp.exe: "다른 앱 선택" 목록에 표시될 이름과 지원 형식
  WriteRegStr HKCU "${MAROHWP_APP_KEY}" "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${MAROHWP_APP_KEY}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "${MAROHWP_APP_KEY}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "${MAROHWP_APP_KEY}\SupportedTypes" ".hwp" ""
  WriteRegStr HKCU "${MAROHWP_APP_KEY}\SupportedTypes" ".hwpx" ""

  ; 탐색기에 연결 정보가 바뀌었음을 알린다 (SHCNE_ASSOCCHANGED)
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "${MAROHWP_CLASSES}\${MAROHWP_PROGID_HWP}"
  DeleteRegKey HKCU "${MAROHWP_CLASSES}\${MAROHWP_PROGID_HWPX}"

  DeleteRegValue HKCU "${MAROHWP_CLASSES}\.hwp\OpenWithProgids" "${MAROHWP_PROGID_HWP}"
  DeleteRegValue HKCU "${MAROHWP_CLASSES}\.hwpx\OpenWithProgids" "${MAROHWP_PROGID_HWPX}"
  ; 우리 값만 지운 뒤, 완전히 빈 껍데기 키만 정리한다 (다른 프로그램의 값이 있으면 그대로 둔다)
  DeleteRegKey /ifempty HKCU "${MAROHWP_CLASSES}\.hwp\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "${MAROHWP_CLASSES}\.hwp"
  DeleteRegKey /ifempty HKCU "${MAROHWP_CLASSES}\.hwpx\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "${MAROHWP_CLASSES}\.hwpx"

  DeleteRegKey HKCU "${MAROHWP_APP_KEY}"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
