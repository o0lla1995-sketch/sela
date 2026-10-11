/**
 * LicenseAlertsService — v47 (الجولة 55 #4).
 * ─────────────────────────────────────────────────────────────────
 * طلب التاجر نصاً: «تأكد من أن التطبيق يرسل تنبيهات عند اقتراب
 * انتهاء الاشتراك أو حتى عند الانتهاء». الخدمة تعمل بعد كل تقييم
 * للبوابة (إقلاع/عودة للتطبيق/كل ٥ دقائق من LicenseGate) وتُصدر:
 *
 *   • اقتراب الانتهاء (٧ أيام فأقل) — إشعار نظام يومي «باقي N يوم»
 *     حتى يجدّد التاجر قبل التوقف (الاقتراب يبدأ من آخر أسبوع فلا
 *     إزعاج قبل ذلك أبداً).
 *   • انتهاء الاشتراك (locked/expired) — إشعار نظام قوي يشرح أن
 *     التطبيق سيطلب التفعيل عند الفتح وأن البيانات سليمة.
 *   • وضع السماح (grace — بلا اتصال بالسيرفر) — إشعار مركز يومي
 *     يذكّر بالاتصال خلال فترة السماح حتى لا يُقفل التطبيق.
 *
 * الخصم مرة واحدة في اليوم لكل حدث (نفس دفتر تنبيهات المخزون) —
 * لا إزعاج ولا تكرار. الحماية نفسها لم تُمس: التقييم والتوقيع
 * والوقت الموثوق وقرار القفل كلها في LicenseService.evaluate() كما
 * هي؛ هذه الخدمة إشعارات فقط — تقرأ النتيجة ولا تشارك في القرار.
 */
import {notificationsStore} from '../stores/notificationsStore';
import {localToday} from '../core/format';
import {getJson, setJson, KEYS} from '../storage/storage';
import type {LicenseStatus} from './license/LicenseService';

/** يبدأ التنبيه من آخر أسبوع من الاشتراك. */
const EXPIRY_WARN_DAYS = 7;

interface LicenseAlertLedger {
  /** مفاتيح أُنذرت اليوم: 'approaching' | 'expired' | 'grace'. */
  keys: string[];
  day: string;
}

function loadLedger(): LicenseAlertLedger {
  const today = localToday();
  const stored = getJson<LicenseAlertLedger>(KEYS.licenseAlertLedger, {
    keys: [],
    day: '',
  });
  if (stored.day !== today) {
    return {keys: [], day: today};
  }
  return stored;
}

let running = false;

export const LicenseAlertsService = {
  /**
   * يقيّم حالة الاشتراك ويُصدر التنبيهات المستحقة — آمن للاستدعاء
   * المتكرر (خصم يومي لكل حدث). لا يرمي أبداً: الإشعارات لا تعطل
   * مسار العمل أبداً.
   */
  evaluate(status: LicenseStatus | null): void {
    if (status == null || running) {
      return;
    }
    running = true;
    try {
      const ledger = loadLedger();
      const keys = new Set(ledger.keys);
      const fresh: string[] = [];

      const remainingDays = Math.ceil(
        Math.max(0, status.remainingMs) / (24 * 3600 * 1000),
      );

      // ① الانتهاء — أقوى تنبيه (نظام + مركز) ويومياً حتى التجديد.
      if (status.state === 'locked' && status.lockReason === 'expired') {
        if (!keys.has('expired')) {
          fresh.push('expired');
          notificationsStore.push(
            'license',
            'انتهى اشتراك سيلا',
            'انتهت مدة الاشتراك — سيطلب التطبيق التفعيل عند الفتح. ' +
              'بياناتك محفوظة وسليمة بالكامل؛ جدّد الاشتراك لتستأنف العمل.',
            {system: true},
          );
        }
      } else if (
        status.state === 'active' &&
        status.license != null &&
        remainingDays <= EXPIRY_WARN_DAYS
      ) {
        // ② الاقتراب — آخر أسبوع فقط: إشعار نظام يومي بعدد الأيام.
        if (!keys.has('approaching')) {
          fresh.push('approaching');
          notificationsStore.push(
            'license',
            'اشتراك سيلا ينتهي قريباً',
            remainingDays <= 1
              ? 'باقي يوم واحد على انتهاء الاشتراك — جدّد اليوم حتى لا يتوقف التطبيق.'
              : `باقي ${remainingDays} أيام على انتهاء الاشتراك — جدّد في وقتك حتى لا يتوقف التطبيق.`,
            {system: true},
          );
        }
      }

      // ③ وضع السماح — بلا اتصال بالسيرفر (مركز فقط؛ الشريط الأصفر
      //    داخل التطبيق يبقى المرجع الحي).
      if (status.state === 'grace') {
        if (!keys.has('grace')) {
          fresh.push('grace');
          notificationsStore.push(
            'license',
            'وضع السماح — بلا اتصال بالسيرفر',
            `لم يتحقق التطبيق من اشتراكك منذ ${Math.floor(
              status.offlineHours,
            )} ساعة. اتصل بالإنترنت خلال فترة السماح حتى لا يُقفل التطبيق تلقائياً.`,
            {system: false},
          );
        }
      }

      if (fresh.length > 0) {
        ledger.keys = [...ledger.keys, ...fresh].slice(-20);
        setJson(KEYS.licenseAlertLedger, ledger);
      }
    } catch {
      // الإشعارات لا تكسر شيئاً أبداً.
    } finally {
      running = false;
    }
  },
};
