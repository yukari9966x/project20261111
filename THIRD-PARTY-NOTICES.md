# 제3자 고지 (Third-party notices)

marohwp 의 파일 엔진(`src/lib/`)과 편집기(`src/editor/`)는 이 저장소에서 직접 작성한 코드이며,
실행할 때 외부 npm 패키지를 쓰지 않습니다. 다만 아래 자료와 도구의 도움을 받았습니다.

## rhwp (MIT License)

- 저장소: https://github.com/edwardkim/rhwp
- Copyright (c) 2025-2026 Edward Kim

쓰인 곳:

1. **빈 문서 틀** — `src/lib/templates.js` 에는 rhwp 저장소의 빈 문서 두 개
   (`template/empty.hwp`, `samples/hwpx/ref/ref_empty.hwpx`. 한글에서 저장한 내용 없는 문서)가 그대로 들어 있습니다.
   새 문서를 만들거나 형식을 바꿔 저장할 때 바탕으로 씁니다.
2. **형식에 관한 지식** — HWP 5.0 공개 문서에 적혀 있지 않은 저장 호환 규칙(문단 끝 표시 비트, 빈 문단의 레코드 구성,
   컨트롤 마스크, 줄 배치 정보를 비우면 한글이 다시 계산한다는 점, 밑줄/취소선 자리표시 값 등)은 rhwp 의 공개 기술 문서
   (`mydocs/tech/hwp_spec_errata.md`, `hwp_save_guide.md` 등)를 참고해 구현했습니다. rhwp 의 코드는 포함하지 않았습니다.

```
MIT License

Copyright (c) 2025-2026 Edward Kim

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 한글 문서 파일 형식 공개 문서

HWP 5.0 / HWPX(OWPML) 형식은 (주)한글과컴퓨터가 공개한 문서를 바탕으로 구현했습니다.

> 본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.

## 설치본에 함께 들어가는 것

- **Electron** (MIT License) 과 그 안의 Chromium 등 구성 요소 — 설치 폴더의 `LICENSE.electron.txt`,
  `LICENSES.chromium.html` 에 라이선스 전문이 들어 있습니다.
- 설치 프로그램은 **electron-builder** (MIT License) 와 **NSIS** (zlib/libpng License) 로 만듭니다.

## 아이콘

`build/icon.*` 는 `scripts/make_icon.py` 로 직접 그린 것입니다. 글자 모양을 그릴 때 Inter 글꼴
(SIL Open Font License 1.1)을 썼습니다. 글꼴 파일 자체는 포함하지 않습니다.
