# Atlas Access Observability

Atlas-Management의 우측 상단 `관리자 로그인`에서 진입하는 운영용 접속 관제 기능이다.

## 목적

- Atlas 루트 `/` 방문 확인
- `/travel/`, `/jobs/`, `/world/`, `/learn/`, `/health/`, `/sketchfy/`, `/archive/` 페이지 진입 확인
- 접속 시간, IP, 서비스, 경로, HTTP 응답, User-Agent 확인
- 최근 기간의 페이지 접속 수, 고유 IP 수, 재방문 IP 수, 서비스별 접속 수 확인

정적 자산(CSS/JS/이미지) 요청은 페이지 방문 집계에서 제외한다.

## 보안 경계

Atlas-Management 자체는 정적 사이트이므로 클라이언트 JavaScript가 IP를 수집하거나 비밀번호를 보관하지 않는다.

```text
Browser
  -> nginx
     -> static /admin/ UI
     -> JSON access log (/var/log/nginx/atlas-access.jsonl)
     -> /api/atlas-admin/* proxy
        -> loopback-only Python service (127.0.0.1:8787)
           -> authenticated log read
```

- 비밀번호 원문은 저장하지 않는다.
- `ATLAS_ADMIN_PASSWORD_HASH`에는 PBKDF2-SHA256 해시만 둔다.
- 세션은 HMAC 서명된 HttpOnly + SameSite=Strict 쿠키를 사용한다.
- HTTPS 운영을 기본값으로 하며 `Secure` 쿠키가 기본이다.
- 관리자 API는 `127.0.0.1`에만 bind한다.
- 선택적으로 `ATLAS_ADMIN_ALLOWED_IPS`에 CIDR/IP allowlist를 설정할 수 있다.
- 로그인 실패는 IP별 15분 창에서 5회로 제한한다.
- nginx 로그는 `$uri`만 기록하고 query string을 기록하지 않아 URL query의 민감정보를 남기지 않는다.
- `/api/atlas-admin/` 응답은 `Cache-Control: no-store`다.

## 파일

```text
admin/
├── index.html
├── admin.css
└── admin.js
ops/
├── atlas_admin_server.py
├── generate_admin_credentials.py
├── nginx/
│   ├── atlas-access-http.conf.example
│   ├── atlas-access-server.conf.example
│   └── atlas-access.logrotate.example
├── systemd/
│   └── atlas-management-admin.service.example
└── tests/
    └── test_atlas_admin_server.py
```

## 운영 환경 변수

`/etc/atlas-management/admin.env` 같은 root-only 파일에 둔다.

```text
ATLAS_ADMIN_PASSWORD_HASH='pbkdf2_sha256$...'
ATLAS_ADMIN_SESSION_SECRET='...'
ATLAS_ACCESS_LOG='/var/log/nginx/atlas-access.jsonl'
ATLAS_ADMIN_BIND='127.0.0.1'
ATLAS_ADMIN_PORT='8787'
ATLAS_ADMIN_COOKIE_SECURE='1'
ATLAS_ADMIN_SESSION_TTL_SECONDS='28800'
# 선택: 단일 IP 또는 CIDR, 쉼표 구분
# ATLAS_ADMIN_ALLOWED_IPS='203.0.113.10/32,2001:db8::/64'
```

비밀값은 Git, shell history, screenshot, 로그에 넣지 않는다.

## Credentials 생성

서버의 TTY에서 실행한다. 비밀번호는 `getpass`로 입력되므로 화면에 echo되지 않는다.

```bash
python3 ops/generate_admin_credentials.py
```

출력되는 두 환경 변수만 root-only 환경 파일에 복사한다. 출력값 자체도 민감정보로 취급한다.

## nginx

`ops/nginx/atlas-access-http.conf.example`의 `log_format`은 nginx `http {}` context에 포함한다.

`ops/nginx/atlas-access-server.conf.example`은 현재 Atlas public `server {}` block에 **추가**한다. 기존 `/`, `/travel/`, `/learn/`, `/health/`, `/jobs/`, `/world/`, `/sketchfy/`, `/archive/`, `/api/` 설정은 교체하거나 삭제하지 않는다.

적용 전후:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## systemd

예제 unit에서 소스 위치를 `/opt/atlas-management`로 가정한다. 실제 배포 위치가 다르면 `ExecStart`만 맞춘다.

```bash
sudo cp ops/systemd/atlas-management-admin.service.example /etc/systemd/system/atlas-management-admin.service
sudo systemctl daemon-reload
sudo systemctl enable --now atlas-management-admin
```

`nginx` user가 `/var/log/nginx/atlas-access.jsonl`을 읽을 수 있는지 확인해야 한다.

## 로그 보존

기본 권장은 14일이다.

```bash
sudo cp ops/nginx/atlas-access.logrotate.example /etc/logrotate.d/atlas-access
```

IP는 개인정보 또는 개인정보에 준하는 운영 데이터로 취급하고 필요 이상 장기 보관하지 않는다.

## Smoke

API 프로세스와 nginx proxy:

```bash
curl -fsS http://127.0.0.1:8787/api/atlas-admin/health
curl -I https://<atlas-host>/admin/
```

인증 없이 접속 로그가 노출되지 않아야 한다.

```bash
curl -i https://<atlas-host>/api/atlas-admin/visits
```

기대값: `401 Unauthorized` 또는 IP allowlist 사용 시 `403 Forbidden`.

브라우저에서는 `/admin/` 로그인 후 다음을 확인한다.

- 최근 접속/고유 IP/재방문 IP 카운트
- 서비스별 접속 카운트
- 접속 시간 KST 표시
- IP, 서비스, 경로, status, User-Agent 테이블
- 기간/서비스/IP/표시 건수 필터
- 로그아웃 후 데이터 재접근 차단

## 테스트

```bash
python3 -m unittest discover -s ops/tests -v
python3 -m py_compile ops/atlas_admin_server.py ops/generate_admin_credentials.py
node --check admin/admin.js
```
