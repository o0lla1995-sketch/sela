/**
 * v28 (round-36 #4) — Google Drive cloud-backup pure logic.
 * ─────────────────────────────────────────────────────────────────
 * The tested rules:
 *
 *  1. buildAuthUrl — the desktop loopback OAuth contract: client id,
 *     127.0.0.1 redirect with the live port, drive.file + email
 *     scopes, offline access + consent (refresh token every link).
 *  2. parseAuthQuery — the loopback redirect capture: code + state,
 *     URL-encoded payloads, access_denied, empty garbage.
 *  3. backupFileName — stable, sortable, Arabic-free file names.
 *  4. isAutoDue / nextAutoAt — the auto-upload schedule: never
 *     uploaded → due immediately; interval floored at 1 day.
 *  5. buildMultipartBody — the Drive multipart/related upload body
 *     (metadata part + JSON part, boundary delimiters everywhere).
 */
import {
  buildAuthUrl,
  parseAuthQuery,
  backupFileName,
  isAutoDue,
  nextAutoAt,
  buildMultipartBody,
  DRIVE_FOLDER_NAME,
} from '../src/services/GoogleDriveService';

const DAY = 86_400_000;

describe('v28 — buildAuthUrl: the desktop loopback OAuth contract', () => {
  test('carries the client id, the loopback redirect and both scopes', () => {
    const url = buildAuthUrl('my-client-123.apps.googleusercontent.com', 45678, 'state-abc');
    expect(url).toContain('client_id=my-client-123.apps.googleusercontent.com');
    expect(url).toContain(encodeURIComponent('http://127.0.0.1:45678/callback'));
    expect(url).toContain(encodeURIComponent('https://www.googleapis.com/auth/drive.file'));
    expect(url).toContain(encodeURIComponent('https://www.googleapis.com/auth/userinfo.email'));
    expect(url).toContain('state=state-abc');
  });

  test('asks for offline access with a fresh consent (refresh token)', () => {
    const url = buildAuthUrl('cid', 80, 's');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('response_type=code');
  });

  test('different ports → different redirect uris (the live server port)', () => {
    const a = buildAuthUrl('cid', 1111, 's');
    const b = buildAuthUrl('cid', 9999, 's');
    expect(a).not.toContain('127.0.0.1%3A9999');
    expect(b).toContain('127.0.0.1%3A9999');
  });
});

describe('v28 — parseAuthQuery: the loopback redirect capture', () => {
  test('extracts code and state', () => {
    const parsed = parseAuthQuery('code=4%2F0Aabc123&scope=1&state=sela-xyz');
    expect(parsed.code).toBe('4/0Aabc123');
    expect(parsed.state).toBe('sela-xyz');
    expect(parsed.error).toBeUndefined();
  });

  test('captures access_denied', () => {
    const parsed = parseAuthQuery('error=access_denied&state=s');
    expect(parsed.error).toBe('access_denied');
    expect(parsed.code).toBeUndefined();
  });

  test('survives empty and garbage queries', () => {
    expect(parseAuthQuery('')).toEqual({});
    expect(parseAuthQuery('novalue&&x=1')).toEqual({});
  });

  test('decodes + as space (form-encoding tolerance)', () => {
    const parsed = parseAuthQuery('error=access+denied');
    expect(parsed.error).toBe('access denied');
  });
});

describe('v28 — backupFileName: stable sortable names', () => {
  test('formats local date + time with the .json suffix', () => {
    const name = backupFileName(new Date(2026, 9, 7, 14, 5));
    expect(name).toBe('sela-backup-2026-10-07_14-05.json');
  });

  test('pads single digits', () => {
    const name = backupFileName(new Date(2026, 0, 3, 9, 2));
    expect(name).toBe('sela-backup-2026-01-03_09-02.json');
  });

  test('sorts chronologically by name', () => {
    const older = backupFileName(new Date(2026, 9, 6, 23, 59));
    const newer = backupFileName(new Date(2026, 9, 7, 0, 1));
    expect(older < newer).toBe(true);
  });
});

describe('v28 — isAutoDue / nextAutoAt: the auto-upload schedule', () => {
  const now = 1_700_000_000_000;

  test('never uploaded → due immediately', () => {
    expect(isAutoDue(0, 7, now)).toBe(true);
    expect(isAutoDue(-1, 3, now)).toBe(true);
    expect(nextAutoAt(0, 7)).toBeNull();
  });

  test('inside the interval → not due; past it → due', () => {
    const last = now - 3 * DAY;
    expect(isAutoDue(last, 7, now)).toBe(false);
    expect(isAutoDue(last, 3, now)).toBe(true);
    // One second past the edge is still due.
    expect(isAutoDue(now - 7 * DAY - 1000, 7, now)).toBe(true);
  });

  test('the interval floors at 1 day and accepts only whole days', () => {
    expect(isAutoDue(now - DAY, 0, now)).toBe(true);
    expect(isAutoDue(now - DAY + 1000, 0.5, now)).toBe(false);
    expect(isAutoDue(now - 2 * DAY, 0.5, now)).toBe(true);
  });

  test('nextAutoAt lands exactly one interval after the last upload', () => {
    const last = now - DAY;
    expect(nextAutoAt(last, 7)).toBe(last + 7 * DAY);
  });
});

describe('v28 — buildMultipartBody: the Drive upload body', () => {
  test('wraps metadata + content with boundary delimiters', () => {
    const body = buildMultipartBody('{"name":"a.json"}', '{"app":"sela"}', 'bnd123');
    expect(body.startsWith('--bnd123\r\n')).toBe(true);
    expect(body).toContain('Content-Type: application/json; charset=UTF-8');
    expect(body).toContain('{"name":"a.json"}');
    expect(body).toContain('Content-Type: application/json\r\n\r\n{"app":"sela"}');
    expect(body.endsWith('--bnd123--')).toBe(true);
  });

  test('metadata and content parts are separated by a full boundary line', () => {
    const body = buildMultipartBody('META', 'CONTENT', 'x');
    const parts = body.split('--x\r\n');
    // '' / META part / CONTENT part + the '--x--' tail rides along
    // with the last segment (it is NOT followed by \r\n).
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe('');
    expect(parts[1]).toContain('META');
    expect(parts[2]).toContain('CONTENT');
    expect(body).toContain('META\r\n--x');
  });
});

describe('v28 — the Drive folder contract', () => {
  test('the folder name is the visible Sela Backups folder', () => {
    expect(DRIVE_FOLDER_NAME).toBe('Sela Backups');
  });
});
