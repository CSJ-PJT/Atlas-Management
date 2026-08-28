import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadUsage } from './access-log.mjs';

const COOKIE_NAME = 'atlas_admin_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_IDENTITY_LIMIT = 10_000;

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function derivePasswordHash(password, salt) {
  return scryptSync(String(password), String(salt), 64).toString('hex');
}

export function issueSession(secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(now / 1_000) + SESSION_TTL_SECONDS,
    nonce: randomBytes(16).toString('hex'),
  })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySession(value, secret, now = Date.now()) {
  const [payload, signature, extra] = String(value || '').split('.');
  if (!payload || !signature || extra) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(decoded.exp) > Math.floor(now / 1_000);
  } catch {
    return false;
  }
}

function readCookie(request, name) {
  const cookies = String(request.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split('=');
    if (key === name) return parts.join('=');
  }
  return '';
}

function json(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    ...headers,
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4_096) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function requireOrigin(request, allowedOrigin) {
  return request.headers.origin === allowedOrigin;
}

function clientIp(request) {
  return String(request.headers['x-real-ip'] || request.socket.remoteAddress || 'unknown');
}

export function createAdminServer(config) {
  const required = ['username', 'passwordSalt', 'passwordHash', 'sessionSecret', 'allowedOrigin', 'logDirectory'];
  for (const key of required) {
    if (!config[key]) throw new Error(`missing_config:${key}`);
  }
  if (String(config.passwordSalt).length < 32) throw new Error('weak_config:passwordSalt');
  if (!/^[a-f0-9]{128}$/i.test(String(config.passwordHash))) throw new Error('weak_config:passwordHash');
  if (String(config.sessionSecret).length < 64) throw new Error('weak_config:sessionSecret');
  const attempts = new Map();

  const authenticated = (request) => verifySession(readCookie(request, COOKIE_NAME), config.sessionSecret);
  const sessionCookie = (value, maxAge) =>
    `${COOKIE_NAME}=${value}; Path=/atlas-admin-api/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        return json(response, 200, { ok: true });
      }
      if (request.method === 'GET' && url.pathname === '/session') {
        return authenticated(request)
          ? json(response, 200, { authenticated: true })
          : json(response, 401, { authenticated: false, message: '관리자 로그인이 필요합니다.' });
      }
      if (request.method === 'POST' && url.pathname === '/session') {
        if (!requireOrigin(request, config.allowedOrigin)) {
          return json(response, 403, { message: '허용되지 않은 요청 출처입니다.' });
        }
        if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
          return json(response, 415, { message: 'JSON 요청만 허용됩니다.' });
        }
        const ip = clientIp(request);
        const now = Date.now();
        for (const [identity, timestamps] of attempts) {
          const active = timestamps.filter((timestamp) => now - timestamp < LOGIN_WINDOW_MS);
          if (active.length) attempts.set(identity, active);
          else attempts.delete(identity);
        }
        if (attempts.size >= LOGIN_IDENTITY_LIMIT && !attempts.has(ip)) {
          const oldest = attempts.keys().next().value;
          if (oldest) attempts.delete(oldest);
        }
        const recent = (attempts.get(ip) || []).filter((timestamp) => now - timestamp < LOGIN_WINDOW_MS);
        if (recent.length >= LOGIN_ATTEMPT_LIMIT) {
          return json(response, 429, { message: '로그인 시도가 너무 많습니다. 15분 후 다시 시도하세요.' });
        }
        const body = await readJsonBody(request);
        const passwordHash = derivePasswordHash(body.password || '', config.passwordSalt);
        const valid = safeEqual(body.username || '', config.username) && safeEqual(passwordHash, config.passwordHash);
        if (!valid) {
          recent.push(now);
          attempts.set(ip, recent);
          return json(response, 401, { message: '관리자 ID 또는 비밀번호가 올바르지 않습니다.' });
        }
        attempts.delete(ip);
        return json(response, 200, { authenticated: true }, {
          'set-cookie': sessionCookie(issueSession(config.sessionSecret, now), SESSION_TTL_SECONDS),
        });
      }
      if (request.method === 'POST' && url.pathname === '/session/logout') {
        if (!requireOrigin(request, config.allowedOrigin)) {
          return json(response, 403, { message: '허용되지 않은 요청 출처입니다.' });
        }
        return json(response, 200, { authenticated: false }, {
          'set-cookie': sessionCookie('', 0),
        });
      }
      if (request.method === 'GET' && url.pathname === '/usage') {
        if (!authenticated(request)) return json(response, 401, { message: '관리자 로그인이 필요합니다.' });
        const usage = await loadUsage(config.logDirectory, {
          days: url.searchParams.get('days'),
          service: url.searchParams.get('service') || 'all',
          page: url.searchParams.get('page'),
          pageSize: url.searchParams.get('pageSize'),
        });
        return json(response, 200, usage);
      }
      return json(response, 404, { message: '관리자 API 경로를 찾을 수 없습니다.' });
    } catch (serverError) {
      const status = serverError.message === 'request_too_large' ? 413 : 400;
      return json(response, status, { message: status === 413 ? '요청이 너무 큽니다.' : '요청을 처리할 수 없습니다.' });
    }
  });
}

export function configFromEnv(environment = process.env) {
  return {
    username: environment.ATLAS_ADMIN_USERNAME,
    passwordSalt: environment.ATLAS_ADMIN_PASSWORD_SALT,
    passwordHash: environment.ATLAS_ADMIN_PASSWORD_HASH,
    sessionSecret: environment.ATLAS_ADMIN_SESSION_SECRET,
    allowedOrigin: environment.ATLAS_ADMIN_ALLOWED_ORIGIN,
    logDirectory: environment.ATLAS_ADMIN_LOG_DIRECTORY || '/var/log/nginx',
  };
}

function isDirectExecution(entryPath) {
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectExecution(process.argv[1])) {
  const host = process.env.ATLAS_ADMIN_HOST || '127.0.0.1';
  const port = Number(process.env.ATLAS_ADMIN_PORT || 3002);
  const server = createAdminServer(configFromEnv());
  server.listen(port, host, () => {
    process.stdout.write(`atlas-management-admin listening on ${host}:${port}\n`);
  });
  const close = () => server.close(() => process.exit(0));
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}
