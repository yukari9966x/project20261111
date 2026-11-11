#!/usr/bin/env node
'use strict';
/*
 * Linux/macOS 에서 wine 없이 Windows 설치 파일을 만들어 보는 "로컬 전용" 빌드.
 *
 *     npm run dist:nowine        →  dist/marohwp-Setup-<버전>.exe
 *
 * 정식 설치 파일은 GitHub Actions(windows-latest)의 `npm run dist` 가 만든다.
 * 이 스크립트는 설정(package.json "build", build/installer.nsh)이 끝까지 빌드되는지
 * 미리 확인하는 용도다. Windows 에서는 `npm run dist` 와 똑같이 동작한다.
 *
 * 왜 필요한가 (electron-builder 26.18.0 기준):
 *   - exe 아이콘/버전 정보 편집은 순수 JS(resedit)라서 wine 이 필요 없다.
 *   - makensis 도 Linux 용 바이너리가 내려받아진다.
 *   - 단 하나, 언인스톨러를 얻으려고 "언인스톨러를 써 주는 설치 파일"을 wine 으로 한 번
 *     실행한다. electron-builder 는 macOS Catalina 용으로 같은 일을 실행 없이 해 주는
 *     UninstallerReader(설치 파일에서 언인스톨러를 그대로 꺼냄)를 이미 갖고 있으므로,
 *     wine 호출 한 군데만 그것으로 바꿔 끼운다. 그 밖의 빌드 과정은 손대지 않는다.
 */

const path = require('node:path');
const builder = require('electron-builder');

if (process.platform !== 'win32') {
  const { WineVmManager } = require('app-builder-lib/out/vm/WineVm');
  const { UninstallerReader } = require('app-builder-lib/out/targets/nsis/nsisUtil');
  const realExec = WineVmManager.prototype.exec;

  WineVmManager.prototype.exec = async function exec(file, args, ...rest) {
    // NsisTarget.computeScriptAndSignUninstaller: exec(<설치 파일>, []) → <이름>.__uninstaller.exe 가 생겨야 한다.
    const isUninstallerWriter = typeof file === 'string' && /\.exe$/i.test(file) && (!args || args.length === 0);
    if (!isUninstallerWriter) return realExec.call(this, file, args, ...rest);
    const uninstaller = path.join(path.dirname(file), `${path.basename(file, 'exe')}__uninstaller.exe`);
    await UninstallerReader.exec(file, uninstaller);
    console.log(`  • (nowine) 언인스톨러를 실행 없이 추출했습니다: ${path.basename(uninstaller)}`);
    return '';
  };
}

builder
  .build({
    targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64),
    publish: 'never',
  })
  .then((artifacts) => {
    for (const file of artifacts) console.log(`  • 완료: ${path.relative(process.cwd(), file)}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
