import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  INCRUIT_STALE_AFTER_MS,
  classifyHealthStatus,
  classifyIncruitJobs,
  classifyLearnAsset,
  classifySketchfyIndex,
  classifyTravelApi,
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

test('Learn 대표 SVG와 Sketchfy public index 계약을 검증한다', () => {
  assert.equal(
    classifyLearnAsset({ ok: true, contentType: 'image/svg+xml', body: '<svg></svg>' }).kind,
    'healthy',
  );
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
