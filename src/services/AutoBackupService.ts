/**
 * AutoBackupService — v62 (الجولة 66 #2): النسخ الاحتياطي التلقائي
 * إلى ذاكرة الهاتف.
 * ─────────────────────────────────────────────────────────────────
 * طلب التاجر حرفياً: «لماذا لا توجد ميزة لتفعيل النسخ الاحتياطي
 * التلقائي في الهاتف في ذاكرة الهاتف؟» — كانت النسخ يدوية فقط
 * (زر في الإعدادات) أو سحابية عبر Google Drive.
 *
 * كيف يعمل الآن:
 *  - مفعّل افتراضياً من الإعدادات (قابل للإيقاف) بتواتر يومي
 *    (أو كل 3 أيام / أسبوعي).
 *  - نسخة JSON مضغوطة (نفس محتوى النسخة اليدوية بالضبط — كل
 *    المنتجات والفواتير والديون والبصمات والإعدادات) تُكتب بصمت
 *    (بلا Toast) إلى Downloads/SmartVisionPOS باسم
 *    sela_auto_backup_YYYY-MM-DD_HHMM.json.
 *  - يُحتفظ بآخر 7 نسخ فقط — الأقدم تُحذف تلقائياً (pruneAutoBackups
 *    الأصلي عبر MediaStore بلا أي إذن إضافي على أندرويد 10+).
 *  - دفتر آخر نسخة (الوقت/المسار/النتيجة) يُعرض في الإعدادات.
 *  - الجدولة: فحص بعد 25 ثانية من الإقلاع ثم كل 30 دقيقة — نقطة
 *    البيع تبقى مفتوحة أياماً، والفحص رخيص (مقارنة وقت محلية).
 *  - لا يعمل أبداً على قاعدة فارغة (منتجات صفر) ولا أثناء
 *    استرجاع نسخة.
 */
import {getJson, setJson, KEYS} from '../storage/storage';
import {logDiag} from '../core/diagnostics';
import {PlatformUtilsNative} from '../native/nativeBridge';
import {getSettings, type AppSettings} from '../stores/settingsStore';
import {BackupService} from './BackupService';

/** بادئة أسماء ملفات النسخ التلقائي في Downloads/SmartVisionPOS. */
export const AUTO_BACKUP_PREFIX = 'sela_auto_backup_';
/** كم نسخة تلقائية تُبقى على الهاتف (الأقدم تُحذف). */
export const AUTO_BACKUP_KEEP_COUNT = 7;
/** فاصل الجدولة: فحص الاستحقاق كل 30 دقيقة. */
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** أول فحص بعد الإقلاع (ثانية إقلاع هادئة). */
const FIRST_CHECK_DELAY_MS = 25 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export interface AutoBackupLedger {
  /** آخر تشغيل ناجح (epoch ms) — 0 = لم ينجح أي تشغيل بعد. */
  lastRunAt: number;
  /** مسار آخر نسخة ناجحة (للعرض في الإعدادات). */
  lastPath: string | null;
  /** آخر رسالة خطأ (null عند النجاح) — يُعرض في الإعدادات. */
  lastError: string | null;
  lastProducts: number;
  lastSales: number;
}

/** قراءة دفتر النسخ التلقائي (لعرضه في الإعدادات). */
export function getAutoBackupLedger(): AutoBackupLedger | null {
  return getJson<AutoBackupLedger | null>(KEYS.autoBackupLedger, null);
}

/** هل حان وقت نسخة تلقائية جديدة؟ (منطق نقي قابل للاختبار). */
export function isAutoBackupDue(
  settings: Pick<AppSettings, 'autoBackupEnabled' | 'autoBackupEveryDays'>,
  ledger: AutoBackupLedger | null,
  now: number,
): boolean {
  if (!settings.autoBackupEnabled) {
    return false;
  }
  if (ledger == null || ledger.lastRunAt <= 0) {
    return true;
  }
  // فشل سابق؟ أعد المحاولة في الدورة التالية (30 دقيقة) لا بعد يوم.
  if (ledger.lastError != null) {
    return now - ledger.lastRunAt >= CHECK_INTERVAL_MS;
  }
  const days = Math.max(1, Math.floor(settings.autoBackupEveryDays || 1));
  return now - ledger.lastRunAt >= days * DAY_MS;
}

/** اسم ملف النسخة بالتوقيت المحلي: sela_auto_backup_2026-10-21_1430. */
export function autoBackupFileName(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    AUTO_BACKUP_PREFIX +
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}.json`
  );
}

let running = false;

/** ينفّذ نسخة تلقائية إذا استحقت — يعيد الدفتر المحدّث أو null
 *  إذا لم تُنفَّذ (غير مستحقة / معطّلة / جارٍ تشغيل واحد). */
export async function runAutoBackup(
  force = false,
): Promise<AutoBackupLedger | null> {
  const settings = getSettings();
  const ledger = getAutoBackupLedger();
  if (!force && !isAutoBackupDue(settings, ledger, Date.now())) {
    return null;
  }
  if (force && !settings.autoBackupEnabled) {
    // «نسخة الآن» اليدوية تعمل حتى لو كان التلقائي مطفأً.
  }
  if (running) {
    return null;
  }
  running = true;
  try {
    const {json, summary} = await BackupService.buildBackupJson({
      compact: true,
    });
    if (summary.products === 0) {
      // قاعدة فارغة — لا معنى لنسخة احتياطية (تثبيت جديد).
      logDiag('backup', 'تخطي النسخة التلقائية — لا منتجات بعد');
      return null;
    }
    if (PlatformUtilsNative == null) {
      throw new Error('وحدة النظام غير متاحة');
    }
    const path = await PlatformUtilsNative.exportFileSilent(
      autoBackupFileName(Date.now()),
      'application/json',
      json,
    );
    // تقليم القديم — فشله لا يُفشل النسخة نفسها.
    try {
      await PlatformUtilsNative.pruneAutoBackups(
        AUTO_BACKUP_PREFIX,
        AUTO_BACKUP_KEEP_COUNT,
      );
    } catch {
      // Older copies stay — disk is cheaper than a failed backup.
    }
    const next: AutoBackupLedger = {
      lastRunAt: Date.now(),
      lastPath: path,
      lastError: null,
      lastProducts: summary.products,
      lastSales: summary.sales,
    };
    setJson(KEYS.autoBackupLedger, next);
    logDiag(
      'backup',
      `نسخة تلقائية: ${summary.products} منتج، ${summary.sales} فاتورة → ${path}`,
    );
    return next;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'خطأ غير معروف';
    const next: AutoBackupLedger = {
      lastRunAt: Date.now(),
      lastPath: ledger?.lastPath ?? null,
      lastError: message,
      lastProducts: ledger?.lastProducts ?? 0,
      lastSales: ledger?.lastSales ?? 0,
    };
    setJson(KEYS.autoBackupLedger, next);
    logDiag('backup', `فشلت النسخة التلقائية: ${message}`, 'warn');
    return next;
  } finally {
    running = false;
  }
}

let schedulerStarted = false;

/** يجدول الفحص الدوري — يُستدعى مرة واحدة من App.tsx. */
export function startAutoBackupScheduler(): void {
  if (schedulerStarted) {
    return;
  }
  schedulerStarted = true;
  const tick = () => {
    void runAutoBackup();
  };
  setTimeout(tick, FIRST_CHECK_DELAY_MS);
  setInterval(tick, CHECK_INTERVAL_MS);
}
