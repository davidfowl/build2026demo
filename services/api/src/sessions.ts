import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { demoUserId } from './shared';

const sessionCookieName = 'calendar_user_id';
const legacyClientCookieNames = ['aspire-user', 'aspire-user-name', 'agent_user_id'];
const adjectives = ['Brave', 'Clever', 'Curious', 'Mellow', 'Swift', 'Witty', 'Sunny', 'Jolly', 'Nimble', 'Quiet'];
const animals = ['Otter', 'Fox', 'Heron', 'Lynx', 'Panda', 'Falcon', 'Badger', 'Marten', 'Ibis', 'Gecko'];

const revokedUserIds = new Set<string>();

export type BrowserSession = {
  userId: string;
  sessionId: string;
  name: string;
  cookie: {
    name: typeof sessionCookieName;
    httpOnly: true;
    sameSite: 'Lax';
    secure: boolean;
    maxAgeSeconds: number;
    value: 'server-only';
  };
};

export function getOrCreateBrowserSession(request: Request, response: Response): BrowserSession {
  deleteLegacyClientCookies(response);

  const existing = tryGetValidUserId(request);
  if (existing) {
    return createSessionInfo(existing, request);
  }

  const userId = createUserId();
  revokedUserIds.delete(userId);
  appendCookie(response, sessionCookieName, userId, createUserCookieOptions(request));
  const session = createSessionInfo(userId, request);
  console.log(`[broker] Created browser session ${session.name} sessionId=${session.sessionId} cookie=${session.cookie.name} secure=${session.cookie.secure}.`);
  return session;
}

export function resetBrowserSession(request: Request, response: Response): BrowserSession {
  deleteLegacyClientCookies(response);

  const previous = tryGetValidUserId(request);
  if (previous) {
    revokedUserIds.add(previous);
  }

  const userId = createUserId();
  revokedUserIds.delete(userId);
  appendCookie(response, sessionCookieName, userId, createUserCookieOptions(request));
  const session = createSessionInfo(userId, request);
  console.log(`[broker] Reset browser session ${session.name} sessionId=${session.sessionId} cookie=${session.cookie.name} secure=${session.cookie.secure}.`);
  return session;
}

function tryGetValidUserId(request: Request): string | undefined {
  const value = parseCookies(request.headers.cookie)[sessionCookieName];
  if (value && isValidUserId(value) && !revokedUserIds.has(value)) {
    return value;
  }
  return undefined;
}

function createSessionInfo(cookieUserId: string, request: Request): BrowserSession {
  const hash = createHash('sha256').update(cookieUserId).digest();
  const sessionId = hash.subarray(0, 6).toString('hex');
  const name = `${adjectives[hash[6] % adjectives.length]} ${animals[hash[7] % animals.length]}`;

  return {
    userId: demoUserId,
    sessionId,
    name,
    cookie: {
      name: sessionCookieName,
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttps(request),
      maxAgeSeconds: 86400,
      value: 'server-only',
    },
  };
}

function createUserId(): string {
  return randomBytes(32).toString('hex');
}

function isValidUserId(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies[name] = decodeURIComponent(value);
    }
  }
  return cookies;
}

function createUserCookieOptions(request: Request): string[] {
  const options = [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=86400',
  ];

  if (isHttps(request)) {
    options.push('Secure');
  }

  return options;
}

function isHttps(request: Request): boolean {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const forwarded = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return request.secure || forwarded?.split(',')[0]?.trim().toLowerCase() === 'https';
}

function appendCookie(response: Response, name: string, value: string, options: string[]): void {
  response.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; ${options.join('; ')}`);
}

function deleteLegacyClientCookies(response: Response): void {
  for (const cookieName of legacyClientCookieNames) {
    response.append('Set-Cookie', `${cookieName}=; Path=/; Max-Age=0`);
  }
}
