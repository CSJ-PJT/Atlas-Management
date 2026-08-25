(() => {
  'use strict';

  const API = '/api/atlas-admin';
  const loginView = document.querySelector('#login-view');
  const dashboardView = document.querySelector('#dashboard-view');
  const loginForm = document.querySelector('#login-form');
  const passwordInput = document.querySelector('#admin-password');
  const loginMessage = document.querySelector('#login-message');
  const dashboardMessage = document.querySelector('#dashboard-message');
  const filterForm = document.querySelector('#filter-form');
  const refreshButton = document.querySelector('#refresh-button');
  const logoutButton = document.querySelector('#logout-button');
  const hoursFilter = document.querySelector('#hours-filter');
  const serviceFilter = document.querySelector('#service-filter');
  const ipFilter = document.querySelector('#ip-filter');
  const limitFilter = document.querySelector('#limit-filter');
  const visitsBody = document.querySelector('#visits-body');
  const resultCount = document.querySelector('#result-count');
  const serviceCounts = document.querySelector('#service-counts');

  const summaryVisits = document.querySelector('#summary-visits');
  const summaryIps = document.querySelector('#summary-ips');
  const summaryRepeat = document.querySelector('#summary-repeat');
  const summaryLatest = document.querySelector('#summary-latest');

  const kstFormatter = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  function setMessage(element, message, ok = false) {
    element.textContent = message || '';
    element.classList.toggle('ok', Boolean(ok));
  }

  async function request(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch (_) {
      payload = {};
    }
    if (!response.ok) {
      const error = new Error(payload.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function showLogin(message = '') {
    dashboardView.hidden = true;
    loginView.hidden = false;
    setMessage(loginMessage, message);
    passwordInput.value = '';
    passwordInput.focus();
  }

  function showDashboard() {
    loginView.hidden = true;
    dashboardView.hidden = false;
    setMessage(loginMessage, '');
  }

  function formatTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : kstFormatter.format(date);
  }

  function renderSummary(summary) {
    summaryVisits.textContent = Number(summary.visits || 0).toLocaleString('ko-KR');
    summaryIps.textContent = Number(summary.unique_ips || 0).toLocaleString('ko-KR');
    summaryRepeat.textContent = Number(summary.repeat_ips || 0).toLocaleString('ko-KR');
    summaryLatest.textContent = formatTime(summary.latest_visit);

    serviceCounts.replaceChildren();
    const rows = Array.isArray(summary.services) ? summary.services : [];
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'privacy-note';
      empty.textContent = '선택 기간에 페이지 접속 기록이 없습니다.';
      serviceCounts.append(empty);
      return;
    }

    rows.forEach((service) => {
      const row = document.createElement('div');
      row.className = 'service-row';
      const label = document.createElement('span');
      label.textContent = service.label || service.service || '-';
      const value = document.createElement('strong');
      value.textContent = Number(service.visits || 0).toLocaleString('ko-KR');
      row.append(label, value);
      serviceCounts.append(row);
    });
  }

  function addTextCell(row, text, className = '') {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = text;
    row.append(cell);
  }

  function renderVisits(visits) {
    visitsBody.replaceChildren();
    const rows = Array.isArray(visits) ? visits : [];
    resultCount.textContent = `${rows.length.toLocaleString('ko-KR')}건`;

    if (!rows.length) {
      const row = document.createElement('tr');
      row.className = 'empty-row';
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.textContent = '조건에 맞는 접속 기록이 없습니다.';
      row.append(cell);
      visitsBody.append(row);
      return;
    }

    rows.forEach((visit) => {
      const row = document.createElement('tr');
      addTextCell(row, formatTime(visit.time), 'time-cell');
      addTextCell(row, visit.ip || '-', 'ip-cell mono');
      addTextCell(row, visit.service_label || visit.service || '-');
      addTextCell(row, visit.uri || '-', 'path-cell mono');
      addTextCell(row, `${visit.method || ''} ${visit.status || ''}`.trim(), 'status-ok mono');
      addTextCell(row, visit.user_agent || '-', 'ua-cell');
      visitsBody.append(row);
    });
  }

  function activeHours() {
    return hoursFilter.value || '24';
  }

  async function loadDashboard() {
    setMessage(dashboardMessage, '조회 중…', true);
    const hours = activeHours();
    const summaryHours = hours === 'all' ? '336' : hours;
    const params = new URLSearchParams({
      hours,
      limit: limitFilter.value || '200',
    });
    if (serviceFilter.value) params.set('service', serviceFilter.value);
    if (ipFilter.value.trim()) params.set('ip', ipFilter.value.trim());

    try {
      const [summary, visitPayload] = await Promise.all([
        request(`/summary?hours=${encodeURIComponent(summaryHours)}`),
        request(`/visits?${params.toString()}`),
      ]);
      renderSummary(summary);
      renderVisits(visitPayload.visits || []);
      setMessage(dashboardMessage, `마지막 조회 ${kstFormatter.format(new Date())}`, true);
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        showLogin(error.status === 403 ? '현재 네트워크에서는 관리자 접근이 허용되지 않습니다.' : '관리자 세션이 만료되었습니다. 다시 로그인해 주세요.');
        return;
      }
      setMessage(dashboardMessage, `접속 로그를 불러오지 못했습니다: ${error.message}`);
    }
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = passwordInput.value;
    if (!password) return;
    setMessage(loginMessage, '인증 중…', true);
    try {
      await request('/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      passwordInput.value = '';
      showDashboard();
      await loadDashboard();
    } catch (error) {
      if (error.status === 429) {
        showLogin('로그인 실패가 반복되어 잠시 차단되었습니다. 잠시 후 다시 시도해 주세요.');
      } else if (error.status === 403) {
        showLogin('현재 네트워크에서는 관리자 접근이 허용되지 않습니다.');
      } else {
        setMessage(loginMessage, '비밀번호가 올바르지 않습니다.');
        passwordInput.select();
      }
    }
  });

  filterForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await loadDashboard();
  });

  refreshButton.addEventListener('click', loadDashboard);

  logoutButton.addEventListener('click', async () => {
    try {
      await request('/logout', { method: 'POST', body: '{}' });
    } catch (_) {
      // The local UI still returns to the login view if the session already expired.
    }
    showLogin('로그아웃되었습니다.');
  });

  async function bootstrap() {
    try {
      const session = await request('/session');
      if (session.authenticated) {
        showDashboard();
        await loadDashboard();
      } else {
        showLogin();
      }
    } catch (error) {
      if (error.status === 403) {
        showLogin('현재 네트워크에서는 관리자 접근이 허용되지 않습니다.');
      } else {
        showLogin('관리자 API에 연결할 수 없습니다. 운영 설정을 확인해 주세요.');
      }
    }
  }

  bootstrap();
})();
