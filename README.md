# REAL Audio to Text Mobile v0.1.0

공인중개사의 상담·회의 녹음을 텍스트로 변환하고 AI로 정리하는 갤럭시(안드로이드)용 웹 앱입니다.
서버 없이 GitHub Pages에서 동작하며, 녹음·텍스트는 휴대폰 안에, API 키는 휴대폰 브라우저에만 저장됩니다.

## 기능
- 녹음: 최대 3시간, 5분 단위 자동 저장(중간에 멈춰도 저장분 보관), 일시정지, 화면 꺼짐 방지
- 파일 불러오기: 휴대폰 녹음 파일(m4a·mp3·wav 등)을 5분 단위로 나눠 저장
- 텍스트 변환: OpenAI 또는 Gemini (Claude는 음성 인식 미지원)
- AI 정리: OpenAI·Gemini·Claude 중 선택, 양식은 "상담 정리" / "회의록"
- 저장: 원본·정리 txt를 내 파일 > 다운로드에 저장, 공유(카카오톡·메일 등), 복사
- 앱 잠금 비밀번호(선택)

## 파일 구성
| 파일 | 역할 |
|---|---|
| index.html | 화면 |
| styles.css | 휴대폰 화면 배치(360~430px) |
| app.js | 녹음·변환·정리·저장 기능 |
| sw.js | 홈 화면 앱 설치·오프라인 실행 |
| manifest.json | 앱 이름·아이콘 |
| icons/icon-192.png, icons/icon-512.png, icons/icon-maskable-512.png | 앱 아이콘 |

## GitHub Pages 게시 절차(처음 1회)
1. PC에서 github.com에 로그인 → 오른쪽 위 **+** → **New repository**
2. Repository name: `real-audio-mobile`, **Public** 선택 → **Create repository**
3. 새 저장소 화면의 **uploading an existing file** 링크 클릭
4. 이 파일들과 **icons 폴더를 통째로** 끌어다 놓기 → 아래 **Commit changes** 클릭
5. 저장소 위쪽 **Settings** → 왼쪽 **Pages** → Branch를 **main**, 폴더 **/(root)** 로 선택 → **Save**
6. 1~3분 뒤 같은 화면 위쪽에 표시되는 주소 확인: `https://(GitHub 아이디).github.io/real-audio-mobile/`

## 휴대폰 설치
1. 갤럭시에서 **Chrome**으로 위 주소 열기
2. 오른쪽 위 **⋮** → **홈 화면에 추가** 또는 **앱 설치**
3. 홈 화면의 **REAL 녹음변환** 아이콘으로 실행
4. **설정** → API 키 입력 → **설정 저장** → **모델 목록 불러오기**로 모델 확인

## 수정본 올리기
저장소에서 **Add file → Upload files**로 바뀐 파일만 다시 올리면 됩니다(같은 이름은 덮어씀).
휴대폰에서는 앱을 완전히 닫았다가 다시 열면 새 버전이 적용됩니다.

## 주의
- API 키를 저장소 파일에 넣지 마십시오. 키는 휴대폰 앱의 설정 화면에서만 입력합니다.
- 고객 상담을 녹음·AI 처리할 때는 사전에 고지하십시오. 녹음은 변환 시 선택한 AI 회사로 전송됩니다.
- 브라우저의 "인터넷 사용 기록 삭제(사이트 데이터 포함)"를 하면 앱 안의 녹음·텍스트가 지워집니다. 필요한 결과는 txt로 저장해 두십시오.
