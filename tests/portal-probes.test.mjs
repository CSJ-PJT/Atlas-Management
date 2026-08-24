import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  INCRUIT_STALE_AFTER_MS,
  classifyHealthStatus,
  classifyIncruitJobs,
  classifyLearnAsset,
  classifyLearnIndex,
  classifySketchfyIndex,
  classifyTravelApi,
  findLearnEntry,
  runServiceProbe,
} from '../atlas-management.js';

test('Health는 operational 및 backendAvailable을 모두 요구한다', () => {
  assert.equal(classifyHealthStatus({ status: 'operational', backendAvailable: true }).kind, 'healthy');
  assert.equal(classifyHealthStatus({ status: 'operational', backendAvailable: false }).kind, 'error');
});

test('Incruit은 공고와 유효한 generatedAt을 요구하고 24시간 뒤 stale 처리한다', () => {
  const now = Date.parse('2026-08-20T02:00:00Z');
  const jobs = [{ id: 'qa-job' }];
  assert.equal(
    classifyIncruitJobs({ generatedAt: '2026-08-20T01:00:00Z', jobPosts: jobs }, { now }).kind,
    'healthy',
  );
  assert.equal(
    classifyIncruitJobs(
      { generatedAt: new Date(now - INCRUIT_STALE_AFTER_MS - 1).toISOString(), jobPosts: jobs },
      { now },
    ).kind,
    'stale',
  );
  assert.equal(classifyIncruitJobs({ generatedAt: 'invalid', jobPosts: jobs }, { now }).kind, 'error');
  assert.equal(classifyIncruitJobs({ generatedAt: new Date(now).toISOString(), jobPosts: [] }, { now }).kind, 'error');
});

test('Travel API는 지도와 검색 설정까지 모두 확인한다', () => {
  assert.equal(
    classifyTravelApi({ ok: true, googleMapsConfigured: true, serpApiConfigured: true }).kind,
    'healthy',
  );
  assert.equal(
    classifyTravelApi({ ok: true, googleMapsConfigured: true, serpApiConfigured: false }).kind,
    'error',
  );
});

test('Learn public index에서 실제 대표 스크립트를 찾고 현재 계약을 검증한다', () => {
  const learnIndex = `
    <div class="app-shell"></div>
    <section id="knowledgeView"></section>
    <script src="app.js?v=backend-atlas-v8"></script>
  `;
  assert.equal(findLearnEntry(learnIndex), '/learn/app.js?v=backend-atlas-v8');
  assert.equal(
    classifyLearnIndex({ ok: true, contentType: 'text/html; charset=utf-8', body: learnIndex }).kind,
    'healthy',
  );
  assert.equal(
    classifyLearnAsset({
      ok: true,
      contentType: 'application/javascript',
      body: 'const bank = window.QUESTION_BANK; navigator.serviceWorker.register("./sw.js");',
    }).kind,
    'healthy',
  );
  assert.equal(
    classifyLearnIndex({ ok: true, contentType: 'text/html', body: '<div class="app-shell"></div>' }).kind,
    'error',
  );
});

test('Learn probe는 폐기된 SVG 대신 index가 가리키는 스크립트를 조회한다', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.startsWith('/learn/?portal-probe=')) {
      return new Response(`
        <div class="app-shell"></div>
        <section id="knowledgeView"></section>
        <script src="app.js?v=backend-atlas-v8"></script>
      `, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url === '/learn/app.js?v=backend-atlas-v8') {
      return new Response(
        'const bank = window.QUESTION_BANK; navigator.serviceWorker.register("./sw.js");',
        { headers: { 'content-type': 'application/javascript' } },
      );
    }
    throw new Error(`unexpected probe URL: ${url}`);
  };

  assert.equal((await runServiceProbe('learn', fetchImpl)).kind, 'healthy');
  assert.equal(requests.length, 2);
  assert.equal(requests[1], '/learn/app.js?v=backend-atlas-v8');
  assert.ok(requests.every((url) => !url.includes('atlas-mark.svg')));
});

test('Sketchfy public index 계약을 검증한다', () => {
  assert.equal(
    classifySketchfyIndex({
      ok: true,
      contentType: 'text/html; charset=utf-8',
      body: '<div id="root"></div><script type="module" src="/sketchfy/assets/index-qa.js"></script>',
    }).kind,
    'healthy',
  );
  assert.equal(
    classifySketchfyIndex({ ok: true, contentType: 'text/html', body: '<div id="root"></div>' }).kind,
    'error',
  );
});

test('index는 다섯 서비스별 probe id와 외부 module을 연결한다', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['travel', 'incruit', 'learn', 'health', 'sketchfy']) {
    assert.match(html, new RegExp(`data-service-id=["']${id}["']`));
  }
  assert.match(html, /<script\s+type=["']module["']\s+src=["']\/atlas-management\.js["']/);
  assert.doesNotMatch(html, /method:\s*["']HEAD["']/);
});

test('Sketchfy Atlas는 서비스 카드와 바로가기에서 두 번째다', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const cardOrder = [...html.matchAll(/class=["']service-card\s+[^"']+["'][^>]+data-service-id=["']([^"']+)["']/g)]
    .map((match) => match[1]);
  const quickList = html.match(/<div class=["']quick-list["'][^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
  const quickOrder = [...quickList.matchAll(/href=["']\/([^/]+)\/["']/g)].map((match) => match[1]);

  assert.deepEqual(cardOrder, ['travel', 'sketchfy', 'incruit', 'learn', 'health']);
  assert.deepEqual(quickOrder, ['travel', 'sketchfy', 'jobs', 'learn', 'health']);
});
