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

  document.querySelector('#route-summary').textContent = `${healthyCount} / ${serviceCards.length}`;
  document.querySelector('#route-summary-detail').textContent =
    `정상 ${healthyCount}개 · 데이터 오래됨 ${staleCount}개 · 점검 필요 ${errorCount}개`;

  const portalStatus = document.querySelector('#portal-status');
  portalStatus.textContent = errorCount > 0
    ? `${errorCount}개 서비스 점검 필요`
    : staleCount > 0
      ? `${staleCount}개 서비스 데이터 오래됨`
      : '모든 서비스 기능 정상';
  const overallKind = errorCount > 0 ? 'error' : staleCount > 0 ? 'stale' : 'healthy';
  setIndicator(document.querySelector('#portal-status-dot'), overallKind);
  setIndicator(document.querySelector('#route-summary-icon'), overallKind);

  const checkedAt = document.querySelector('#checked-at');
  checkedAt.textContent = checkTime;
  checkedAt.dateTime = new Date().toISOString();
  document.querySelector('#last-check-summary').textContent = checkTime;

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

if (typeof document !== 'undefined') {
  wireNavigation();
  checkPortal();
}
