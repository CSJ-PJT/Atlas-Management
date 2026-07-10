# Atlas Management

<p align="center">
  <img src="./atlas-logo.png" alt="Atlas Management Logo" width="360" />
</p>

<p align="center">
  여러 Atlas 서비스를 한 곳에서 확인하고 진입하기 위한 통합 관리 포털입니다.
</p>

---

## 개요

Atlas Management는 독립적으로 운영되는 Atlas 서비스들을 하나의 홈 화면에서 관리하기 위한 정적 웹 포털입니다.

현재 포털은 다음 역할을 수행합니다.

- Atlas 브랜드의 공통 진입점 제공
- 운영 중인 Atlas 서비스 목록 표시
- 각 서비스의 목적과 접속 경로 안내
- 서비스 상태와 API 상태를 한 화면에서 확인
- 사용자가 `/`, `/travel/`, `/learn/`, `/health/`, `/jobs/`로 빠르게 이동할 수 있는 허브 제공

이 저장소는 백엔드 애플리케이션이 아니라 nginx 루트 경로 `/`에서 동작하는 정적 사이트입니다.

## 로고와 브랜드

Atlas Management는 공통 Atlas 로고 자산을 사용합니다.

- `atlas-logo.png`: README 및 브랜드 노출용 메인 로고
- `atlas-mark.svg`: 웹 헤더, favicon, 서비스 브랜드 마크
- `atlas-mark.png`: Apple touch icon 및 브라우저 북마크용 이미지

포털 상단 브랜드 영역과 브라우저 북마크 아이콘은 `atlas-mark`를 기준으로 통일되어 있습니다.

## 현재 연결된 서비스

| 서비스 | 경로 | 역할 |
| --- | --- | --- |
| Travel Atlas | `/travel/` | 여행 일정, 장소, 좌표, 이동 경로를 지도 위에서 관리하는 여행 서비스 |
| Learn Atlas | `/learn/` | 백엔드 지식, 면접, 설계 역량을 훈련하는 학습 플랫폼 |
| Health Atlas | `/health/` | 건강, 운동, 수면 데이터를 기록하고 확인하는 헬스 대시보드 |
| Incruit Atlas | `/jobs/` | 백엔드·AX 채용 공고를 수집하고 지원 상태와 알림을 관리하는 채용 관제 서비스 |
| Atlas API | `/api/health` | 운영 API 상태 확인용 헬스 체크 엔드포인트 |

## 파일 구조

```text
Atlas-Management/
├── index.html              # 포털 메인 화면
├── atlas-management.css    # 반응형 레이아웃 및 UI 스타일
├── atlas-logo.png          # README/브랜드용 메인 로고
├── atlas-mark.svg          # 헤더/파비콘용 Atlas 마크
├── atlas-mark.png          # 북마크/터치 아이콘용 이미지
└── README.md               # 프로젝트 설명 문서
```

## 실행 방법

정적 사이트이므로 별도의 빌드 과정이 필요 없습니다.

로컬에서 확인할 때는 브라우저로 `index.html`을 열거나 간단한 정적 서버를 사용합니다.

```bash
cd /home/opc/Atlas-Management
python3 -m http.server 8080
```

접속:

```text
http://127.0.0.1:8080/
```

운영 환경에서는 nginx 루트 경로 `/`에 배포됩니다.

```text
/usr/share/nginx/html/
```

## 운영 배포 기준

Atlas Management는 nginx 루트 `/`에만 배포합니다.

다음 서비스 디렉터리는 Atlas Management 배포 과정에서 삭제하거나 덮어쓰면 안 됩니다.

```text
/usr/share/nginx/html/travel
/usr/share/nginx/html/learn
/usr/share/nginx/html/health
/usr/share/nginx/html/jobs
```

또한 `/api/` proxy 설정은 Atlas Management와 별개로 유지해야 합니다.

## nginx 경로 역할

| 경로 | 처리 방식 |
| --- | --- |
| `/` | Atlas Management 정적 포털 |
| `/travel/` | Travel Atlas 정적 앱 |
| `/learn/` | Learn Atlas 정적 앱 |
| `/health/` | Health Atlas 정적 앱 |
| `/jobs/` | Incruit Atlas 정적 앱 |
| `/api/` | Atlas API proxy |

## 현재 UI 구성

포털은 다음 영역으로 구성됩니다.

- 상단 브랜드 바
- 서비스 포털 네비게이션
- 운영 상태 메타 정보
- 등록 서비스 수 요약
- 서비스별 카드
- 운영 바로가기 패널
- API 상태 카드
- ArchiveOS 관제 연동 예정 안내

## 이 포털이 수행하는 역할

Atlas Management는 각 서비스를 직접 실행하거나 데이터를 처리하지 않습니다.

대신 다음 책임을 가집니다.

- 사용자가 어떤 Atlas 서비스가 있는지 파악하게 한다.
- 서비스별 목적과 경로를 명확히 보여준다.
- 운영자가 전체 서비스 상태를 빠르게 확인하게 한다.
- 새 Atlas 서비스가 추가될 때 같은 구조로 카드만 확장할 수 있게 한다.
- 개별 서비스 장애가 루트 포털 전체 장애로 보이지 않도록 역할을 분리한다.

## 추가하면 좋다고 판단되는 부분

현재는 정적 포털이므로 표시되는 상태값이 수동 관리에 가깝습니다. 운영 관점에서는 아래 기능을 추가하는 것이 좋습니다.

### 1. 실제 헬스 체크 자동화

각 서비스의 응답 상태를 주기적으로 확인해 카드 상태를 자동 갱신하는 기능이 필요합니다.

대상:

- `/travel/`
- `/learn/`
- `/health/`
- `/jobs/`
- `/api/health`

정적 HTML만으로는 제한이 있으므로, 작은 JSON 상태 파일이나 API 응답을 읽는 방식이 적합합니다.

### 2. 마지막 배포 시간 자동 표시

현재 포털의 마지막 확인 시간은 수동 값입니다.

배포 스크립트에서 다음과 같은 파일을 생성하면 더 정확합니다.

```text
/usr/share/nginx/html/atlas-status.json
```

예상 필드:

```json
{
  "deployedAt": "2026-07-10T00:00:00+09:00",
  "version": "git-sha",
  "services": []
}
```

### 3. 서비스별 상세 상태

단순히 “운영 중”만 보여주는 것보다 다음 상태가 있으면 좋습니다.

- 정상
- 점검 중
- 배포 대기
- 오류
- API 연결 필요
- 정적 리소스 누락

### 4. ArchiveOS 관제 연동

ArchiveOS를 Atlas 운영 이벤트의 중앙 수집 지점으로 연결하면 좋습니다.

이벤트 후보:

- `service_deployed`
- `service_health_checked`
- `service_unavailable`
- `nginx_reloaded`
- `api_health_failed`
- `atlas_portal_updated`

### 5. 운영 문서 링크

각 서비스 카드에 운영 문서나 README 링크를 추가하면 장애 대응이 빨라집니다.

예:

- Travel Atlas 좌표/지도 운영 가이드
- Learn Atlas 콘텐츠 업데이트 가이드
- Health Atlas 배포 가이드
- Incruit Atlas Slack/Supabase 환경변수 가이드

### 6. 서비스 추가용 데이터 구조 분리

현재 서비스 목록은 `index.html`에 직접 작성되어 있습니다.

서비스가 더 늘어나면 다음 구조가 더 적합합니다.

```text
services.json
```

```json
[
  {
    "name": "Travel Atlas",
    "path": "/travel/",
    "status": "running",
    "description": "여행 일정과 경로를 지도 위에서 관리합니다."
  }
]
```

이렇게 분리하면 HTML 수정 없이 서비스 카드 확장이 쉬워집니다.

## 개발 원칙

- `/travel/`, `/learn/`, `/health/`, `/jobs/`, `/api/` 경로에 영향을 주지 않는다.
- 루트 `/`의 정적 포털만 수정한다.
- secret, API key, webhook 값은 절대 포함하지 않는다.
- 운영 배포 전 nginx 설정과 기존 서비스 응답을 확인한다.
- Atlas 브랜드 자산은 가능하면 공통 로고 체계를 따른다.

## 운영 확인 명령

운영 서버에서 배포 후 최소한 아래 항목을 확인합니다.

```bash
curl -I http://127.0.0.1/
curl -I http://127.0.0.1/travel/
curl -I http://127.0.0.1/learn/
curl -I http://127.0.0.1/health/
curl -I http://127.0.0.1/jobs/
curl -I http://127.0.0.1/api/health
```

nginx 설정 검증:

```bash
sudo nginx -t
```

## 향후 방향

Atlas Management는 단순 링크 모음이 아니라 Atlas 서비스군의 운영 관제 홈으로 발전시키는 것이 좋습니다.

우선순위는 다음 순서가 적절합니다.

1. 실제 서비스 상태 자동 확인
2. 배포 시간과 git commit SHA 표시
3. 서비스별 운영 문서 링크 추가
4. 장애/점검 상태 표시
5. ArchiveOS 이벤트 연동
6. `services.json` 기반 카드 자동 렌더링

