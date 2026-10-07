/**
 * GoogleDriveService — v28 (round-36 #4) cloud backups on Google Drive.
 * ─────────────────────────────────────────────────────────────────
 * What the merchant asked for, exactly:
 *
 *   • ربط حساب Google Drive لمرة واحدة (OAuth) — the app gets a
 *     narrow drive.file scope: it can ONLY see the files it created.
 *   • نسخ احتياطية تلقائية كل فترة بالأيام يحددها المستخدم —
 *     uploaded DIRECTLY to the account the moment the period has
 *     passed AND the internet is available.
 *   • صفحة خاصة تعرض كل النسخ المرفوعة على الدرايف.
 *   • استرجاع آخر نسخة مرفوعة أو اختيار أي نسخة بعينها.
 *
 * HOW THE OAUTH WORKS (no extra npm packages, no manifest changes):
 * The merchant creates a "Desktop app" OAuth client in their own
 * Google Cloud Console (guided in-app, one-time) and pastes the
 * Client ID + Secret. Google's DESKTOP loopback flow is then used:
 * a one-shot native HTTP server binds 127.0.0.1:port
 * (PlatformUtilsModule.startLoopbackAuth), the browser opens the
 * consent screen, and Google redirects to http://127.0.0.1:port/
 * callback?code=… — the browser and the app share the device, so
 * the loopback server captures the code, answers a small Arabic
 * success page and pulls the app back to the front. Google ignores
 * the PORT when matching loopback redirects, so the OS-assigned
 * port needs no pre-registration. No client SHA-1 binding either —
 * works with any signing key.
 *
 * All Drive traffic is the official REST v3 over fetch:
 *   ensure folder "Sela Backups" → multipart upload (compact JSON)
 *   → files.list (createdTime desc) → alt=media download → delete.
 *
 * The scheduler: startAutoScheduler() runs from App boot — an
 * initial check ~25s after boot (let the app settle) plus a cheap
 * re-check every 15 minutes. maybeAutoBackup() is a no-op unless
 * [connected && enabled && due && online]; a failed upload keeps
 * lastUploadAt untouched so the next cycle retries.
 */
import {DeviceEventEmitter, Linking} from 'react-native';
import type {EmitterSubscription} from 'react-native';
import {requirePlatformUtils} from '../native/nativeBridge';
import {SelaNotificationsNative} from '../native/nativeBridge';
import {BackupService, type BackupFile} from './BackupService';
import {
  deleteKey,
  getBoolean,
  getJson,
  getNumber,
  getString,
  setBoolean,
  setJson,
  setNumber,
  setString,
  KEYS,
} from '../storage/storage';
import {logDiag} from '../core/diagnostics';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL =
  'https://www.googleapis.com/upload/drive/v3/files';

/** The Drive scope: create/manage ONLY files this app made. */
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const EMAIL_SCOPE =
  'https://www.googleapis.com/auth/userinfo.email';

/** The visible Drive folder that carries every backup. */
export const DRIVE_FOLDER_NAME = 'Sela Backups';

/** The native event carrying the loopback redirect outcome. */
const DRIVE_AUTH_EVENT = 'selaDriveAuth';

/** How long the loopback server waits for the browser redirect. */
const AUTH_TIMEOUT_MS = 180_000;

export interface DriveBackupFile {
  id: string;
  name: string;
  sizeBytes: number;
  createdAtMs: number;
}

export interface DriveHistoryEntry {
  at: number;
  name?: string;
  ok: boolean;
  reason: 'manual' | 'auto';
  error?: string;
  sizeBytes?: number;
}

export type AutoBackupOutcome =
  | 'uploaded'
  | 'busy'
  | 'skipped-disabled'
  | 'skipped-not-due'
  | 'skipped-offline'
  | 'failed';

/** Thrown when the stored refresh token was revoked/expired — the
 *  merchant must re-link the account. */
export class DriveSessionExpiredError extends Error {
  constructor(message = 'انتهت صلاحية الربط مع جوجل — اربط الحساب مجدداً من شاشة النسخ السحابي') {
    super(message);
    this.name = 'DriveSessionExpiredError';
  }
}

// ────────────────────────────────────────────────────────────────
// Pure helpers (100% testable — __tests__/drive-backup.test.ts)
// ────────────────────────────────────────────────────────────────

/** Builds the Google OAuth consent URL (desktop loopback flow). */
export function buildAuthUrl(
  clientId: string,
  port: number,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `http://127.0.0.1:${port}/callback`,
    response_type: 'code',
    scope: `${DRIVE_SCOPE} ${EMAIL_SCOPE}`,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Parses the loopback redirect query (?code=…&state=… / ?error=…). */
export function parseAuthQuery(
  query: string,
): {code?: string; state?: string; error?: string} {
  const out: {code?: string; state?: string; error?: string} = {};
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const key = pair.slice(0, eq);
    const value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, '%20'));
    if (key === 'code' || key === 'state' || key === 'error') {
      out[key] = value;
    }
  }
  return out;
}

/** The Drive file name for a backup taken at `now` (local time). */
export function backupFileName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `sela-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-` +
    `${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}.json`
  );
}

/** Is an automatic upload due? (never-uploaded → due immediately). */
export function isAutoDue(
  lastUploadAt: number,
  intervalDays: number,
  now: number,
): boolean {
  if (!Number.isFinite(lastUploadAt) || lastUploadAt <= 0) {
    return true;
  }
  const days = Math.max(1, Math.floor(intervalDays || 1));
  return now - lastUploadAt >= days * 86_400_000;
}

/** When the next automatic upload becomes due (for the UI display). */
export function nextAutoAt(
  lastUploadAt: number,
  intervalDays: number,
): number | null {
  if (!Number.isFinite(lastUploadAt) || lastUploadAt <= 0) {
    return null;
  }
  const days = Math.max(1, Math.floor(intervalDays || 1));
  return lastUploadAt + days * 86_400_000;
}

/** Builds a Drive multipart/related upload body (metadata + JSON). */
export function buildMultipartBody(
  metadataJson: string,
  content: string,
  boundary: string,
): string {
  return (
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n' +
    '\r\n' +
    `${metadataJson}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: application/json\r\n' +
    '\r\n' +
    `${content}\r\n` +
    `--${boundary}--`
  );
}

/** URL-encodes ONE query parameter value (Google wants %20, not +). */
function enc(value: string): string {
  return encodeURIComponent(value);
}

// ────────────────────────────────────────────────────────────────
// Config persistence (MMKV)
// ────────────────────────────────────────────────────────────────

export const DriveConfig = {
  getClientId(): string {
    return getString(KEYS.driveClientId, '');
  },
  setClientId(value: string): void {
    setString(KEYS.driveClientId, value.trim());
  },
  getClientSecret(): string {
    return getString(KEYS.driveClientSecret, '');
  },
  setClientSecret(value: string): void {
    setString(KEYS.driveClientSecret, value.trim());
  },
  /** Linked = a refresh token exists. */
  isConnected(): boolean {
    return getString(KEYS.driveRefreshToken, '').length > 0;
  },
  getRefreshToken(): string {
    return getString(KEYS.driveRefreshToken, '');
  },
  getAccessToken(): string {
    return getString(KEYS.driveAccessToken, '');
  },
  getAccessExpiresAt(): number {
    return getNumber(KEYS.driveAccessExpiresAt, 0);
  },
  getAccountEmail(): string {
    return getString(KEYS.driveAccountEmail, '');
  },
  getFolderId(): string {
    return getString(KEYS.driveFolderId, '');
  },
  getAutoEnabled(): boolean {
    return getBoolean(KEYS.driveAutoEnabled, false);
  },
  setAutoEnabled(value: boolean): void {
    setBoolean(KEYS.driveAutoEnabled, value);
  },
  getAutoIntervalDays(): number {
    return Math.max(1, getNumber(KEYS.driveAutoIntervalDays, 3));
  },
  setAutoIntervalDays(value: number): void {
    setNumber(KEYS.driveAutoIntervalDays, Math.max(1, Math.floor(value)));
  },
  getLastUploadAt(): number {
    return getNumber(KEYS.driveLastUploadAt, 0);
  },
  getHistory(): DriveHistoryEntry[] {
    return getJson<DriveHistoryEntry[]>(KEYS.driveHistory, []);
  },
  /** Prepends an entry, keeps the newest 30. */
  appendHistory(entry: DriveHistoryEntry): void {
    const next = [entry, ...DriveConfig.getHistory()].slice(0, 30);
    setJson(KEYS.driveHistory, next);
  },
  /** Clears the whole link (tokens + schedule + history). */
  wipe(): void {
    for (const key of [
      KEYS.driveRefreshToken,
      KEYS.driveAccessToken,
      KEYS.driveAccessExpiresAt,
      KEYS.driveAccountEmail,
      KEYS.driveFolderId,
      KEYS.driveAutoEnabled,
      KEYS.driveLastUploadAt,
      KEYS.driveHistory,
    ]) {
      deleteKey(key);
    }
  },
};

// ────────────────────────────────────────────────────────────────
// Token plumbing
// ────────────────────────────────────────────────────────────────

async function tokenRequest(
  body: Record<string, string>,
): Promise<{access_token: string; expires_in: number; refresh_token?: string}> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: Object.entries(body)
      .map(([k, v]) => `${enc(k)}=${enc(v)}`)
      .join('&'),
  });
  const json = (await res.json().catch(() => null)) as
    | {access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string}
    | null;
  if (!res.ok || json?.access_token == null) {
    const detail =
      json?.error_description ?? json?.error ?? `HTTP ${res.status}`;
    throw new Error(`فشل مصادقة جوجل: ${detail}`);
  }
  return {
    access_token: json.access_token,
    expires_in: json.expires_in ?? 3600,
    refresh_token: json.refresh_token,
  };
}

/** A valid access token — refreshed when expired (throws
 *  DriveSessionExpiredError when the refresh token itself is dead). */
async function ensureAccessToken(): Promise<string> {
  const token = DriveConfig.getAccessToken();
  const expiresAt = DriveConfig.getAccessExpiresAt();
  if (token.length > 0 && expiresAt - 60_000 > Date.now()) {
    return token;
  }
  const refresh = DriveConfig.getRefreshToken();
  if (refresh.length === 0) {
    throw new DriveSessionExpiredError();
  }
  try {
    const next = await tokenRequest({
      client_id: DriveConfig.getClientId(),
      client_secret: DriveConfig.getClientSecret(),
      refresh_token: refresh,
      grant_type: 'refresh_token',
    });
    setString(KEYS.driveAccessToken, next.access_token);
    setNumber(
      KEYS.driveAccessExpiresAt,
      Date.now() + next.expires_in * 1000,
    );
    return next.access_token;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('invalid_grant')) {
      throw new DriveSessionExpiredError();
    }
    throw error;
  }
}

/** fetch with Authorization + timeouts + one retry after refresh. */
async function driveFetch(
  url: string,
  init?: RequestInit & {timeoutMs?: number},
  attempt = 0,
): Promise<Response> {
  const token = await ensureAccessToken();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    init?.timeoutMs ?? 30_000,
  );
  let res: Response;
  try {
    const {timeoutMs: _timeoutMs, ...rest} = init ?? {};
    res = await fetch(url, {
      ...rest,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (String(error).includes('abort')) {
      throw new Error('انتهت مهلة الاتصال بجوجل — تحقق من الإنترنت وحاول مجدداً');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 && attempt === 0) {
    // Force a refresh and retry once.
    setNumber(KEYS.driveAccessExpiresAt, 0);
    return driveFetch(url, init, 1);
  }
  return res;
}

// ────────────────────────────────────────────────────────────────
// The loopback OAuth flow
// ────────────────────────────────────────────────────────────────

/** Wraps the native "selaDriveAuth" event into a promise. */
function waitForAuthEvent(
  timeoutMs: number,
): Promise<{query?: string; error?: string}> {
  return new Promise((resolve, reject) => {
    const sub: EmitterSubscription = DeviceEventEmitter.addListener(
      DRIVE_AUTH_EVENT,
      (event: {query?: string; error?: string}) => {
        cleanup();
        if (event?.query != null) {
          resolve({query: String(event.query)});
        } else {
          const kind = event?.error ?? 'error';
          reject(
            new Error(
              kind === 'timeout'
                ? 'انتهت مهلة الربط — لم تُكمل تسجيل الدخول في المتصفح. حاول مجدداً'
                : 'تم إلغاء عملية الربط',
            ),
          );
        }
      },
    );
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('انتهت مهلة الربط — حاول مجدداً'));
    }, timeoutMs);
    function cleanup() {
      sub.remove();
      clearTimeout(timer);
    }
  });
}

// ────────────────────────────────────────────────────────────────
// The service
// ────────────────────────────────────────────────────────────────

async function ensureFolderId(): Promise<string> {
  const cached = DriveConfig.getFolderId();
  if (cached.length > 0) {
    const res = await driveFetch(
      `${DRIVE_FILES_URL}/${enc(cached)}?fields=id,trashed`,
    );
    if (res.ok) {
      const json = (await res.json()) as {id?: string; trashed?: boolean};
      if (json.id != null && json.trashed !== true) {
        return cached;
      }
    }
    // Missing/trashed → fall through and resolve/create a fresh one.
  }
  const q = enc(
    `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );
  const list = await driveFetch(
    `${DRIVE_FILES_URL}?q=${q}&fields=files(id,name)&pageSize=5`,
  );
  if (list.ok) {
    const json = (await list.json()) as {files?: {id: string}[]};
    const found = json.files?.[0]?.id;
    if (found != null) {
      setString(KEYS.driveFolderId, found);
      return found;
    }
  }
  const create = await driveFetch(DRIVE_FILES_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  if (!create.ok) {
    throw new Error(
      `تعذّر إنشاء مجلد «${DRIVE_FOLDER_NAME}» في درايف (HTTP ${create.status})`,
    );
  }
  const created = (await create.json()) as {id?: string};
  if (created.id == null) {
    throw new Error('تعذّر إنشاء مجلد النسخ في درايف');
  }
  setString(KEYS.driveFolderId, created.id);
  return created.id;
}

/** The single upload path (manual + auto share it). */
async function uploadBackupNow(
  reason: 'manual' | 'auto',
): Promise<{name: string; sizeBytes: number}> {
  const folderId = await ensureFolderId();
  const {json, summary} = await BackupService.buildBackupJson({compact: true});
  const name = backupFileName(new Date());
  const boundary = `sela${Date.now().toString(36)}`;
  const body = buildMultipartBody(
    JSON.stringify({
      name,
      parents: [folderId],
      description: `نسخة احتياطية من تطبيق سيلا — ${summary.products} منتج، ${summary.sales} فاتورة`,
    }),
    json,
    boundary,
  );
  const res = await driveFetch(
    `${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,name,size,createdTime`,
    {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
      // Big catalogs take a while on POS-grade internet.
      timeoutMs: 180_000,
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `فشل رفع النسخة إلى درايف (HTTP ${res.status})${detail ? ` — ${detail.slice(0, 120)}` : ''}`,
    );
  }
  const file = (await res.json()) as {id?: string; size?: string};
  const sizeBytes = Number(file.size ?? body.length);
  setNumber(KEYS.driveLastUploadAt, Date.now());
  DriveConfig.appendHistory({at: Date.now(), name, ok: true, reason, sizeBytes});
  logDiag('drive', `تم رفع نسخة إلى Google Drive: ${name}`);
  return {name, sizeBytes};
}

export const GoogleDriveService = {
  /** The full OAuth loopback link flow → connected account email. */
  async connect(): Promise<{email: string}> {
    const clientId = DriveConfig.getClientId();
    const clientSecret = DriveConfig.getClientSecret();
    if (clientId.length === 0 || clientSecret.length === 0) {
      throw new Error('أكمل Client ID و Client Secret في إعداد الربط أولاً');
    }
    const platform = requirePlatformUtils();
    let port: number;
    try {
      port = await platform.startLoopbackAuth(AUTH_TIMEOUT_MS);
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error('تعذّر بدء خادم الربط');
    }
    const state = `sela${Date.now().toString(36)}`;
    const opened = await Linking.openURL(
      buildAuthUrl(clientId, port, state),
    ).then(
      () => true,
      () => false,
    );
    if (!opened) {
      await platform.cancelLoopbackAuth().catch(() => undefined);
      throw new Error(
        'تعذّر فتح المتصفح — تأكد أن هناك متصفحاً مثبتاً على الجهاز ثم حاول مجدداً',
      );
    }
    // Subscribe only now — the browser JUST opened; the redirect can't
    // possibly land before the user types their consent (seconds away),
    // and this way a failed openURL never leaks a dangling listener.
    const outcomePromise = waitForAuthEvent(AUTH_TIMEOUT_MS + 10_000);
    try {
      const outcome = await outcomePromise;
      const parsed = parseAuthQuery(outcome.query ?? '');
      if (parsed.error === 'access_denied') {
        throw new Error(
          'تم رفض أذونات درايف — يجب السماح بالوصول لتعمل النسخ السحابية',
        );
      }
      if (parsed.code == null) {
        throw new Error('لم يصل رمز التفويض من جوجل — حاول مجدداً');
      }
      if (parsed.state != null && parsed.state !== state) {
        throw new Error('رمز الحماية غير مطابق — أعد محاولة الربط');
      }
      const tokens = await tokenRequest({
        code: parsed.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `http://127.0.0.1:${port}/callback`,
        grant_type: 'authorization_code',
      });
      setString(KEYS.driveAccessToken, tokens.access_token);
      setNumber(
        KEYS.driveAccessExpiresAt,
        Date.now() + tokens.expires_in * 1000,
      );
      if (tokens.refresh_token != null) {
        // prompt=consent always returns one — keep the newest.
        setString(KEYS.driveRefreshToken, tokens.refresh_token);
      }
      // Show WHICH account got linked (multi-account merchants).
      let email = '';
      try {
        const info = await fetch(USERINFO_URL, {
          headers: {Authorization: `Bearer ${tokens.access_token}`},
        });
        if (info.ok) {
          const parsedInfo = (await info.json()) as {email?: string};
          email = parsedInfo.email ?? '';
        }
      } catch {
        // Cosmetic — the link works without it.
      }
      setString(KEYS.driveAccountEmail, email);
      await ensureFolderId();
      logDiag('drive', `تم ربط Google Drive (${email || 'حساب جوجل'})`);
      return {email};
    } finally {
      // If we threw before the redirect landed, stop the server.
      await platform.cancelLoopbackAuth().catch(() => undefined);
    }
  },

  /** Revokes the stored grant + clears the whole link state. */
  async disconnect(): Promise<void> {
    const refresh = DriveConfig.getRefreshToken();
    try {
      if (refresh.length > 0) {
        await fetch(`${REVOKE_URL}?token=${enc(refresh)}`, {method: 'POST'});
      }
    } catch {
      // Offline revoke — Google drops it on next link anyway.
    }
    DriveConfig.wipe();
    logDiag('drive', 'تم فصل ربط Google Drive');
  },

  /** Builds a fresh backup and uploads it to the Drive folder. */
  async uploadBackup(
    reason: 'manual' | 'auto' = 'manual',
  ): Promise<{name: string; sizeBytes: number}> {
    return uploadBackupNow(reason);
  },

  /** Every backup on Drive (newest first), for the dedicated page. */
  async listBackups(): Promise<DriveBackupFile[]> {
    const folderId = await ensureFolderId();
    const q = enc(`'${folderId}' in parents and trashed=false`);
    const url =
      `${DRIVE_FILES_URL}?q=${q}` +
      `&orderBy=${enc('createdTime desc')}&pageSize=100` +
      `&fields=${enc('files(id,name,size,createdTime)')}`;
    const res = await driveFetch(url);
    if (!res.ok) {
      throw new Error(`تعذّر قراءة قائمة النسخ من درايف (HTTP ${res.status})`);
    }
    const json = (await res.json()) as {
      files?: {id: string; name: string; size?: string; createdTime?: string}[];
    };
    return (json.files ?? [])
      .filter(file => file.id != null && file.name != null)
      .map(file => ({
        id: file.id,
        name: file.name,
        sizeBytes: Number(file.size ?? 0),
        createdAtMs: file.createdTime ? Date.parse(file.createdTime) : 0,
      }));
  },

  /** Downloads a Drive backup + validates it — ready to restore. */
  async downloadBackup(fileId: string): Promise<BackupFile> {
    const res = await driveFetch(
      `${DRIVE_FILES_URL}/${enc(fileId)}?alt=media`,
      {timeoutMs: 180_000},
    );
    if (!res.ok) {
      throw new Error(`فشل تنزيل النسخة من درايف (HTTP ${res.status})`);
    }
    const content = await res.text();
    return BackupService.parseAndValidateBackup(content);
  },

  /** Deletes a backup file from Drive. */
  async deleteBackup(fileId: string): Promise<void> {
    const res = await driveFetch(
      `${DRIVE_FILES_URL}/${enc(fileId)}`,
      {method: 'DELETE'},
    );
    if (!res.ok && res.status !== 204) {
      throw new Error(`فشل حذف النسخة من درايف (HTTP ${res.status})`);
    }
  },

  /** True when the device is online (native ConnectivityManager). */
  async isOnline(): Promise<boolean> {
    try {
      return await requirePlatformUtils().isNetworkAvailable();
    } catch {
      return false;
    }
  },

  /**
   * The auto-backup gate: connected && enabled && due && online →
   * upload (with a system notification on success). A failure keeps
   * lastUploadAt so the next cycle retries — nothing is ever skipped
   * because of a transient offline/upload error.
   */
  async maybeAutoBackup(): Promise<AutoBackupOutcome> {
    if (autoRunning) {
      return 'busy';
    }
    if (!DriveConfig.isConnected() || !DriveConfig.getAutoEnabled()) {
      return 'skipped-disabled';
    }
    if (
      !isAutoDue(
        DriveConfig.getLastUploadAt(),
        DriveConfig.getAutoIntervalDays(),
        Date.now(),
      )
    ) {
      return 'skipped-not-due';
    }
    let online = false;
    try {
      online = await requirePlatformUtils().isNetworkAvailable();
    } catch {
      online = false;
    }
    if (!online) {
      return 'skipped-offline';
    }
    autoRunning = true;
    try {
      const result = await uploadBackupNow('auto');
      try {
        await SelaNotificationsNative?.show(
          Date.now() % 2_000_000_000,
          'نسخة احتياطية سحابية',
          `تم رفع نسخة احتياطية تلقائياً إلى Google Drive (${result.name})`,
          'backup',
        );
      } catch {
        // Notification is cosmetic.
      }
      return 'uploaded';
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'خطأ غير معروف';
      DriveConfig.appendHistory({
        at: Date.now(),
        ok: false,
        reason: 'auto',
        error: message,
      });
      logDiag('drive', `فشل الرفع التلقائي: ${message}`, 'error');
      return 'failed';
    } finally {
      autoRunning = false;
    }
  },
};

// ────────────────────────────────────────────────────────────────
// The scheduler (started once from App boot — a no-op when the
// merchant never linked/enabled cloud backups)
// ────────────────────────────────────────────────────────────────

let autoTimer: ReturnType<typeof setInterval> | null = null;
let autoRunning = false;

export function startAutoScheduler(): void {
  if (autoTimer != null) {
    return;
  }
  // First check after the app settles — boot is heavy (DB + model).
  setTimeout(() => {
    void GoogleDriveService.maybeAutoBackup();
  }, 25_000);
  // Cheap timestamp check every 15 minutes; the upload itself only
  // fires when due + online.
  autoTimer = setInterval(() => {
    void GoogleDriveService.maybeAutoBackup();
  }, 15 * 60 * 1000);
}
