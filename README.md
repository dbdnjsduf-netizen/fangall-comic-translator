# 판갤 만화번역기

Codex 계정으로 로그인해 만화·일본만화 이미지의 글자를 인식하고, 자연스러운 한국어 번역이 들어간 이미지로 저장하는 Windows용 로컬 웹 앱입니다.

> 이 프로젝트는 비공식 커뮤니티 도구이며 OpenAI의 공식 제품이 아닙니다. 프로그램은 개인 PC의 `127.0.0.1`에서만 실행됩니다. 각 사용자는 반드시 자신의 Codex/ChatGPT 계정을 사용해야 합니다.

## 가장 빠른 실행 방법: Windows 휴대용 버전

1. [Releases](https://github.com/dbdnjsduf-netizen/fangal-comic-translator/releases/latest)에서 이름에 `windows-x64`가 들어간 ZIP을 내려받습니다.
2. ZIP을 완전히 압축 해제합니다.
3. `launch-comic-translator.cmd`를 더블클릭합니다.
4. Codex 로그인이 없으면 브라우저 로그인 안내가 열립니다. 본인의 계정으로 로그인합니다.
5. 자동으로 열리는 `http://127.0.0.1:3344`에서 이미지를 올리고 번역을 시작합니다.

휴대용 버전에는 Windows x64용 Node.js와 npm 패키지가 포함되어 있어 별도 설치가 필요 없습니다.

## 소스 ZIP으로 실행

1. 이 페이지 오른쪽 위의 **Code → Download ZIP**을 눌러 내려받고 압축을 풉니다.
2. [Node.js LTS](https://nodejs.org/)를 설치합니다. Node.js 20 이상을 권장합니다.
3. `launch-comic-translator.cmd`를 더블클릭합니다.
4. 첫 실행에는 필요한 npm 패키지가 자동 설치됩니다.
5. Codex 로그인 안내를 완료합니다.

두 번째 실행부터는 같은 파일을 더블클릭하면 됩니다. 콘솔을 통해 실행하고 싶지 않다면 `launch-comic-translator.vbs`를 사용해도 됩니다.

## 결과 저장 위치

완성된 이미지는 실행한 사용자의 다음 폴더에 저장됩니다.

```text
내 사용자 폴더\Downloads\번역 완료\
```

예를 들어 Windows 사용자 이름이 `mango`라면 기본 위치는 다음과 같습니다.

```text
C:\Users\mango\Downloads\번역 완료\
```

Windows에서 다운로드 폴더를 OneDrive나 다른 드라이브로 옮긴 경우에는 기본 사용자 폴더 아래에 `Downloads\번역 완료`가 새로 만들어질 수 있습니다. 앱 폴더의 `output\`에도 브라우저 미리보기용 사본이 생성됩니다.

## 지원 흐름

- 만화/일본만화: 전체 페이지 OCR → 독립적인 2차 재검증 → 한국어 이미지 생성
- 문서 이미지: 문서용 OCR·번역 → 한국어 이미지 생성
- 카드게임 이미지: 아이콘과 비텍스트 요소를 보호하면서 텍스트 현지화
- 번역 결과의 원문·번역문 수정 및 이미지 재생성
- 보호 영역/복구 영역 브러시 편집
- 여러 페이지 병렬 처리

기본 만화 흐름은 Codex 로그인과 Node.js만으로 실행됩니다.

## 선택 기능용 Python 설치

Patch Atlas와 일부 고급 로컬 검출 기능을 사용하려면 Python 3.10 이상을 설치한 뒤 다음 명령을 실행합니다.

```powershell
python -m pip install -r requirements-optional.txt
```

기본 전체 페이지 번역 흐름만 사용할 때는 먼저 설치하지 않아도 됩니다.

## 개인정보와 로그인 정보

- Codex 로그인 토큰은 이 저장소에 저장되지 않습니다.
- 로그인 정보는 Codex가 관리하는 사용자별 `~/.codex/auth.json` 또는 운영체제 자격 증명 저장소에 있습니다.
- `.env`, 로그인 캐시, 업로드 이미지, 결과 이미지, 로그는 `.gitignore`로 제외됩니다.
- `auth.json`은 비밀번호와 같으므로 절대로 다른 사람에게 보내거나 GitHub에 올리지 마세요.
- 다른 사람이 이 저장소를 내려받으면 그 사람 자신의 Codex 로그인 정보가 사용됩니다.

## 주의사항

- 인터넷에 서버로 배포하거나 여러 사람이 하나의 계정을 공유하는 용도로 사용하지 마세요.
- 번역할 이미지와 생성된 번역본의 저작권 및 배포 권한은 사용자가 직접 확인해야 합니다.
- 모델 이용량과 사용 가능 모델은 각 사용자의 Codex/ChatGPT 계정과 워크스페이스 정책을 따릅니다.
- 앱을 종료하려면 실행 중인 서버 창을 닫거나 `restart-comic-translator.vbs`로 다시 시작합니다.

## 직접 실행

```powershell
npm install
npm start
```

브라우저에서 `http://127.0.0.1:3344`를 엽니다.

## 라이선스와 출처

이 저장소는 `openai-oauth@1.0.2`와의 라이선스 호환성을 위해 AGPL-3.0-only로 공개합니다. 포함된 모델과 참고 프로젝트 등 제3자 구성요소의 출처는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에서 확인할 수 있습니다.
