const PROBE_TIMEOUT_MS = 8_000;
export const INCRUIT_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
const FUTURE_CLOCK_TOLERANCE_MS = 5 * 60 * 1_000;

const healthy = (detail) => ({ kind: 'healthy', label: '사용 가능', detail });
const stale = (detail) => ({ kind: 'stale', label: '데이터 오래됨', detail });
const error = (detail) => ({ kind: 'error', label: '점검 필요', detail });

export function classifyHealthStatus(data) {
  return data?.status === 'operational' && data?.backendAvailable === true
    ? healthy('Health 인증 및 백엔드 사용 가능')
    : error('Health 상태 또는 백엔드 연결을 확인해야 합니다.');
}

export function classifyIncruitJobs(
  data,
  { now = Date.now(), staleAfterMs = INCRUIT_STALE_AFTER_MS } = {},
) {
  if (!Array.isArray(data?.jobPosts) || data.jobPosts.length === 0) {
    return error('수집된 채용 공고가 없습니다.');
  }

  const generatedAt = Date.parse(data.generatedAt);
  if (!Number.isFinite(generatedAt) || generatedAt > now + FUTURE_CLOCK_TOLERANCE_MS) {
    return error('채용 데이터 생성 시간이 유효하지 않습니다.');
  }

  const ageMs = Math.max(0, now - generatedAt);
  const ageHours = Math.floor(ageMs / (60 * 60 * 1_000));
  const detail = `채용 공고 ${data.jobPosts.length}개 · ${ageHours}시간 전 갱신`;
  return ageMs > staleAfterMs ? stale(detail) : healthy(detail);
}

export function classifyTravelApi(data) {
  return data?.ok === true &&
    data?.googleMapsConfigured === true &&
    data?.serpApiConfigured === true
    ? healthy('지도 및 장소 검색 API 사용 가능')
    : error('여행 지도 또는 장소 검색 API 설정을 확인해야 합니다.');
}

export function findLearnEntry(body) {
  const src = body.match(/<script\b[^>]*\bsrc=["']([^"']*\/?app\.js(?:\?[^"']*)?)["'][^>]*>/i)?.[1];
  if (/^(?:\.\/)?app\.js(?:\?[^#]*)?$/.test(src || '')) {
    return `/learn/${src.replace(/^\.\//, '')}`;
  }
  return /^\/learn\/app\.js(?:\?[^#]*)?$/.test(src || '') ? src : null;
}

export function classifyLearnIndex({ ok, contentType, body }) {
  const hasAppShell = /<div\b[^>]*\bclass=["'][^"']*\bapp-shell\b[^"']*["']/i.test(body);
  const hasKnowledgeView = /<section\b[^>]*\bid=["']knowledgeView["']/i.test(body);
  return ok &&
    contentType.toLowerCase().includes('text/html') &&
    hasAppShell &&
    hasKnowledgeView &&
    findLearnEntry(body)
    ? healthy('학습 애플리케이션 진입점 확인')
    : error('학습 애플리케이션 진입점을 확인해야 합니다.');
}

export function classifyLearnAsset({ ok, contentType, body }) {
  const isJavaScript = contentType.toLowerCase().includes('javascript');
  const hasQuestionBank = /window\.QUESTION_BANK/.test(body);
  const hasServiceWorkerRegistration = /serviceWorker\.register/.test(body);
  return ok && isJavaScript && hasQuestionBank && hasServiceWorkerRegistration
    ? healthy('학습 애플리케이션 대표 스크립트 사용 가능')
    : error('학습 애플리케이션 대표 스크립트를 확인해야 합니다.');
}

export function classifySketchfyIndex({ ok, contentType, body }) {
  const hasRoot = /<div\s+[^>]*id=["']root["'][^>]*>/i.test(body);
  const hasEntry = /<script\s+[^>]*type=["']module["'][^>]*src=["']\/sketchfy\/assets\/[^"']+\.js["']/i.test(
    body,
  );
  return ok && contentType.toLowerCase().includes('text/html') && hasRoot && hasEntry
    ? healthy('Sketchfy 공개 애플리케이션 진입점 사용 가능')
    : error('Sketchfy 공개 애플리케이션 진입점을 확인해야 합니다.');
}

async function fetchWithTimeout(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(response) {
  const body = await response.text();
  return JSON.parse(body.replace(/^\uFEFF/, ''));
}

async function probeJson(url, classifier, fetchImpl) {
  const response = await fetchWithTimeout(url, fetchImpl);
  if (!response.ok) return error(`${url} 응답: HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return error(`${url} 응답 형식이 JSON이 아닙니다.`);
  }
  return classifier(await readJson(response));
}

export async function runServiceProbe(serviceId, fetchImpl = fetch) {
  try {
    switch (serviceId) {
      case 'health':
        return await probeJson('/health/health-status.json', classifyHealthStatus, fetchImpl);
      case 'incruit':
        return await probeJson('/jobs/data/live-jobs.json', classifyIncruitJobs, fetchImpl);
      case 'travel':
        return await probeJson('/api/health', classifyTravelApi, fetchImpl);
      case 'learn': {
        const indexResponse = await fetchWithTimeout(`/learn/?portal-probe=${Date.now()}`, fetchImpl);
        const indexBody = await indexResponse.text();
        const indexResult = classifyLearnIndex({
          ok: indexResponse.ok,
          contentType: indexResponse.headers.get('content-type') || '',
          body: indexBody,
        });
        if (indexResult.kind !== 'healthy') return indexResult;

        const response = await fetchWithTimeout(findLearnEntry(indexBody), fetchImpl);
        return classifyLearnAsset({
          ok: response.ok,
          contentType: response.headers.get('content-type') || '',
          body: await response.text(),
        });
      }
      case 'sketchfy': {
        const response = await fetchWithTimeout('/sketchfy/', fetchImpl);
        return classifySketchfyIndex({
          ok: response.ok,
          contentType: response.headers.get('content-type') || '',
          body: await response.text(),
        });
      }
      default:
        return error('등록되지 않은 서비스 probe입니다.');
    }
  } catch (probeError) {
    return error(probeError?.name === 'AbortError' ? '상태 확인 시간이 초과됐습니다.' : '상태 확인에 실패했습니다.');
  }
}

function setIndicator(indicator, kind) {
  indicator.classList.remove('is-ok', 'is-warning', 'is-error');
  if (kind === 'healthy') indicator.classList.add('is-ok');
  if (kind === 'stale') indicator.classList.add('is-warning');
  if (kind === 'error') indicator.classList.add('is-error');
}

function formatCheckTime() {
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(new Date());
}

async function checkCard(card) {
  const state = card.querySelector('.service-state');
  const result = await runServiceProbe(card.dataset.serviceId);
  state.textContent = result.label;
  state.title = result.detail;
  state.setAttribute('aria-label', `${result.label}: ${result.detail}`);
  state.classList.toggle('is-stale', result.kind === 'stale');
  state.classList.toggle('is-unavailable', result.kind === 'error');
  card.dataset.serviceState = result.kind;
  return result;
}

async function checkPortal() {
  const serviceCards = [...document.querySelectorAll('[data-service-id]')];
  const results = await Promise.all(serviceCards.map(checkCard));
  const healthyCount = results.filter(({ kind }) => kind === 'healthy').length;
  const staleCount = results.filter(({ kind }) => kind === 'stale').length;
  const errorCount = results.filter(({ kind }) => kind === 'error').length;
  const checkTime = formatCheckTime();

  const portalStatus = document.querySelector('#portal-status');
  portalStatus.textContent = errorCount > 0
    ? `${errorCount}개 서비스 점검 필요`
    : staleCount > 0
      ? `${staleCount}개 서비스 데이터 오래됨`
      : '모든 서비스 기능 정상';
  const overallKind = errorCount > 0 ? 'error' : staleCount > 0 ? 'stale' : 'healthy';
  setIndicator(document.querySelector('#portal-status-dot'), overallKind);

  const checkedAt = document.querySelector('#checked-at');
  checkedAt.textContent = checkTime;
  checkedAt.dateTime = new Date().toISOString();

  const apiStatus = document.querySelector('#api-status');
  const apiIndicator = document.querySelector('#api-status-dot');
  const apiResult = await runServiceProbe('travel');
  apiStatus.textContent = apiResult.kind === 'healthy'
    ? 'API와 필수 외부 서비스 설정이 정상입니다.'
    : apiResult.detail;
  setIndicator(apiIndicator, apiResult.kind);
}

function wireNavigation() {
  document.querySelectorAll('.nav-links a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (event) => {
      const target = document.querySelector(link.getAttribute('href'));
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

const ADMIN_API_BASE = '/atlas-admin-api';
const ADMIN_SERVICE_LABELS = {
  portal: 'Atlas Management',
  travel: 'Travel Atlas',
  incruit: 'Incruit Atlas',
  learn: 'Learn Atlas',
  health: 'Health Atlas',
  sketchfy: 'Sketchfy Atlas',
  world: 'Archive World',
  archive: 'Archive',
  archiveos: 'ArchiveOS',
  other: '기타',
};

export function formatAdminService(service) {
  return ADMIN_SERVICE_LABELS[service] || service || '기타';
}

async function adminRequest(path, options = {}) {
  const response = await fetch(`${ADMIN_API_BASE}${path}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const requestError = new Error(payload.message || '관리자 요청을 처리하지 못했습니다.');
    requestError.status = response.status;
    throw requestError;
  }
  return payload;
}

function wireAdminPanel() {
  const dialog = document.querySelector('#admin-dialog');
  const openButton = document.querySelector('#admin-login-button');
  const closeButton = document.querySelector('#admin-close-button');
  const loginForm = document.querySelector('#admin-login-form');
  const usagePanel = document.querySelector('#admin-usage');
  const loginMessage = document.querySelector('#admin-login-message');
  const usageMessage = document.querySelector('#admin-usage-message');
  const serviceFilter = document.querySelector('#admin-service-filter');
  const daysFilter = document.querySelector('#admin-days-filter');
  const rows = document.querySelector('#admin-usage-rows');
  let currentPage = 1;
  let totalPages = 1;

  const showAuthenticated = (authenticated) => {
    loginForm.hidden = authenticated;
    usagePanel.hidden = !authenticated;
    openButton.textContent = authenticated ? '관리 기록' : '관리자';
  };

  const renderRows = (records) => {
    rows.replaceChildren();
    if (records.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.className = 'admin-empty-row';
      cell.textContent = '선택한 조건의 이용 기록이 없습니다.';
      row.append(cell);
      rows.append(row);
      return;
    }
    records.forEach((record) => {
      const row = document.createElement('tr');
      [
        new Date(record.time).toLocaleString('ko-KR'),
        record.ip,
        formatAdminService(record.service),
        `${record.method} ${record.path}`,
        String(record.status),
      ].forEach((value) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      });
      rows.append(row);
    });
  };

  const loadUsage = async (page = currentPage) => {
    usageMessage.textContent = '이용 기록을 불러오는 중입니다.';
    try {
      const query = new URLSearchParams({
        service: serviceFilter.value,
        days: daysFilter.value,
        page: String(page),
        pageSize: '50',
      });
      const data = await adminRequest(`/usage?${query}`);
      currentPage = data.page;
      totalPages = data.totalPages;
      document.querySelector('#admin-total-count').textContent = String(data.total);
      document.querySelector('#admin-unique-ip-count').textContent = String(data.uniqueIpCount);
      document.querySelector('#admin-period-label').textContent = `${data.days}일`;
      document.querySelector('#admin-page-label').textContent = `${currentPage} / ${totalPages}`;
      document.querySelector('#admin-prev-button').disabled = currentPage <= 1;
      document.querySelector('#admin-next-button').disabled = currentPage >= totalPages;
      renderRows(data.records);
      usageMessage.textContent = `최근 ${data.days}일 기록 ${data.total}건을 관리자 권한으로 조회했습니다.`;
    } catch (usageError) {
      if (usageError.status === 401) {
        showAuthenticated(false);
        loginMessage.textContent = '세션이 만료되었습니다. 다시 로그인하세요.';
      } else {
        usageMessage.textContent = usageError.message;
      }
    }
  };

  openButton.addEventListener('click', async () => {
    loginMessage.textContent = '';
    dialog.showModal();
    try {
      await adminRequest('/session');
      showAuthenticated(true);
      await loadUsage(1);
    } catch {
      showAuthenticated(false);
      document.querySelector('#admin-username').focus();
    }
  });

  closeButton.addEventListener('click', () => dialog.close());

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    loginMessage.textContent = '관리자 인증 중입니다.';
    const username = document.querySelector('#admin-username').value;
    const passwordInput = document.querySelector('#admin-password');
    try {
      await adminRequest('/session', {
        method: 'POST',
        body: JSON.stringify({ username, password: passwordInput.value }),
      });
      passwordInput.value = '';
      loginMessage.textContent = '';
      showAuthenticated(true);
      await loadUsage(1);
    } catch (loginError) {
      passwordInput.value = '';
      loginMessage.textContent = loginError.message;
      passwordInput.focus();
    }
  });

  document.querySelector('#admin-refresh-button').addEventListener('click', () => loadUsage(currentPage));
  serviceFilter.addEventListener('change', () => loadUsage(1));
  daysFilter.addEventListener('change', () => loadUsage(1));
  document.querySelector('#admin-prev-button').addEventListener('click', () => loadUsage(Math.max(1, currentPage - 1)));
  document.querySelector('#admin-next-button').addEventListener('click', () => loadUsage(Math.min(totalPages, currentPage + 1)));
  document.querySelector('#admin-logout-button').addEventListener('click', async () => {
    await adminRequest('/session/logout', { method: 'POST' });
    showAuthenticated(false);
    rows.replaceChildren();
    loginMessage.textContent = '로그아웃했습니다.';
  });
}

if (typeof document !== 'undefined') {
  wireNavigation();
  wireAdminPanel();
  checkPortal();
}
