import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { createAdminServer, derivePasswordHash, issueSession, verifySession } from '../server/admin-server.mjs';
import { classifyService, loadUsage, parseAccessLine } from '../server/access-log.mjs';

const sampleLine = (ip, time, target, status = 200) =>
  `${ip} - - [${time}] "GET ${target} HTTP/1.1" ${status} 123 "-" "Mozilla/5.0" "-"`;

test('Nginx 접근 로그에서 IP, 시간, 서비스와 기능 경로만 추출한다', () => {
  const record = parseAccessLine(sampleLine('203.0.113.7', '25/Aug/2026:09:10:11 +0000', '/sketchfy/room/qa?token=secret'));
  assert.deepEqual(record, {
    ip: '203.0.113.7',
    time: '2026-08-25T09:10:11.000Z',
    method: 'GET',
    path: '/sketchfy/room/qa',
    status: 200,
    service: 'sketchfy',
  });
  assert.equal(parseAccessLine(sampleLine('203.0.113.7', '25/Aug/2026:09:10:11 +0000', '/jobs/assets/index.js')), null);
  assert.equal(parseAccessLine(sampleLine('203.0.113.7', '25/Aug/2026:09:10:11 +0000', '/atlas-admin-api/usage')), null);
  assert.equal(classifyService('/api/place-search'), 'travel');
  assert.equal(classifyService('/archiveos/api/health'), 'archiveos');
});

test('이용 기록은 기간, 서비스, 페이지와 고유 IP를 계산한다', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atlas-access-'));
  try {
    await writeFile(path.join(directory, 'access.log'), [
      sampleLine('203.0.113.7', '25/Aug/2026:09:10:11 +0000', '/sketchfy/'),
      sampleLine('198.51.100.2', '25/Aug/2026:09:11:11 +0000', '/jobs/'),
      sampleLine('203.0.113.7', '25/Aug/2026:09:12:11 +0000', '/sketchfy/data/status.json'),
    ].join('\n'));
    const usage = await loadUsage(directory, {
      now: Date.parse('2026-08-25T10:00:00Z'), days: 1, service: 'sketchfy', pageSize: 1, page: 1,
    });
    assert.equal(usage.total, 2);
    assert.equal(usage.uniqueIpCount, 1);
    assert.equal(usage.totalPages, 2);
    assert.equal(usage.records.length, 1);
    assert.equal(usage.records[0].path, '/sketchfy/data/status.json');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('세션은 서명과 만료를 검증한다', () => {
  const now = Date.parse('2026-08-25T09:00:00Z');
  const value = issueSession('session-secret', now);
  assert.equal(verifySession(value, 'session-secret', now + 1_000), true);
  assert.equal(verifySession(value, 'wrong-secret', now + 1_000), false);
  assert.equal(verifySession(value, 'session-secret', now + 9 * 60 * 60 * 1_000), false);
});

test('관리자 API는 Origin, 비밀번호 해시와 HttpOnly 세션 뒤에서만 로그를 제공한다', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atlas-admin-'));
  const salt = 'qa-salt';
  await writeFile(path.join(directory, 'access.log'), sampleLine('203.0.113.9', '25/Aug/2026:09:10:11 +0000', '/health/'));
  const server = createAdminServer({
    username: 'admin',
    passwordSalt: salt,
    passwordHash: derivePasswordHash('correct-password', salt),
    sessionSecret: 'qa-session-secret-at-least-32-bytes',
    allowedOrigin: 'https://atlas.example',
    logDirectory: directory,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/usage`)).status, 401);
    assert.equal((await fetch(`${base}/session`, { method: 'POST', body: '{}' })).status, 403);
    const rejected = await fetch(`${base}/session`, {
      method: 'POST', headers: { origin: 'https://atlas.example', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    assert.equal(rejected.status, 401);
    const login = await fetch(`${base}/session`, {
      method: 'POST', headers: { origin: 'https://atlas.example', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct-password' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    const usage = await fetch(`${base}/usage?days=1`, { headers: { cookie } });
    assert.equal(usage.status, 200);
    const payload = await usage.json();
    assert.equal(payload.total, 1);
    assert.equal(payload.records[0].ip, '203.0.113.9');
  } finally {
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
  }
});
