/**
 * v62 — الجولة 66: ملاحظات التاجر الخمسة.
 * ─────────────────────────────────────────────────────────────────
 * ① بيانات التواصل الحية من الخادم في شاشة التفعيل — كانت تعرض
 *    الرقم/البريد الاحتياطيين المدمجين على أي جهاز لم يُفعّل بعد
 *    (لا كاش)؛ الآن /api/v1/config يُجلب عند فتح الشاشة والإعدادات.
 * ② النسخ الاحتياطي التلقائي إلى ذاكرة الهاتف — مفعّل افتراضياً،
 *    نسخة مضغوطة كل N أيام في Downloads/SmartVisionPOS مع الاحتفاظ
 *    بآخر 7 نسخ وحذف الأقدم أصلياً عبر MediaStore.
 * ③ تقرير الكاشير: المؤشرات شبكة ٢×٣ حتمية (كانت ستّ بطاقات
 *    متلاصقة في صف واحد) + فلترة الفواتير بالنوع وتصفح تدريجي.
 * ④ التحديث الإجباري: الخادم يوزّع minAppVersion/updateUrl مع كل
 *    رد، والجهاز الأقدم من الحد يُقفل على شاشة تحديث غير قابلة
 *    للتجاوز حتى يحدّث.
 * ⑤ نافذة إضافة كاشير: «التالي» بين الحقول، إظهار كلمة المرور،
 *    أخطاء داخلية لكل حقل، تمرير داخلي، و«إنشاء وإضافة التالي».
 * ⑥ الإصدار: 71.0.0 (79).
 */
import {
  isVersionBelow,
  parseVersionParts,
  getUpdateRequirement,
  adoptUpdateInfoIfProvided,
} from '../src/services/license/LicenseService';
import {
  isAutoBackupDue,
  autoBackupFileName,
  AUTO_BACKUP_PREFIX,
  AUTO_BACKUP_KEEP_COUNT,
  type AutoBackupLedger,
} from '../src/services/AutoBackupService';
import {load} from './helpers/app';

const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;
const DAY = 86_400_000;

describe('v62 — ④ التحديث الإجباري: مقارنة الإصدارات (منطق نقي)', () => {
  test('parseVersionParts: أرقام بنقاط بأطوال مختلفة', () => {
    expect(parseVersionParts('62.0.0')).toEqual([62, 0, 0]);
    expect(parseVersionParts('62')).toEqual([62]);
    expect(parseVersionParts('v61.10.3')).toEqual([61, 10, 3]);
    expect(parseVersionParts('garbage')).toEqual([0]);
  });

  test('isVersionBelow: الأقدم فقط هو الذي يُجبر', () => {
    expect(isVersionBelow('61.0.0', '62.0.0')).toBe(true);
    expect(isVersionBelow('62.0.0', '62.0.0')).toBe(false);
    expect(isVersionBelow('63.1.0', '62.0.0')).toBe(false);
    // مقارنة جزئية: 61.9 < 61.10 رقمياً لا نصياً.
    expect(isVersionBelow('61.9.0', '61.10.0')).toBe(true);
    // نسخة أقصر تكمل أصفاراً.
    expect(isVersionBelow('62', '62.0.1')).toBe(true);
  });

  test('adoptUpdateInfoIfProvided ثم getUpdateRequirement: التوجيه يعمل ويُفرغ', () => {
    const storage = load('src/storage/storage').storage;
    const KEYS = load('src/storage/storage').KEYS;
    storage.delete(KEYS.updateRequirement);
    // بلا توجيه: لا إجبار.
    expect(getUpdateRequirement().required).toBe(false);
    // توجيه بحد أدنى أعلى من إصدار البناء (71.0.0): 72.0.0: إجبار + رابط. (v70: الإصدار الجديد يقلب المقارنة — الحارس يُحرَّض للأعلى دائماً)
    adoptUpdateInfoIfProvided({minAppVersion: '72.0.0', updateUrl: 'https://play.google.com/x'});
    const req = getUpdateRequirement();
    expect(req.required).toBe(true);
    expect(req.minVersion).toBe('72.0.0');
    expect(req.updateUrl).toBe('https://play.google.com/x');
    expect(req.currentVersion).toBe('71.0.0');
    // إفراغ الخادم يلغي الإجبار.
    adoptUpdateInfoIfProvided({minAppVersion: '', updateUrl: ''});
    expect(getUpdateRequirement().required).toBe(false);
    // رد بلا الحقل إطلاقاً (خادم قديم) لا يمس الكاش.
    storage.delete(KEYS.updateRequirement);
    adoptUpdateInfoIfProvided({minAppVersion: '72.0.0', updateUrl: ''});
    adoptUpdateInfoIfProvided({somethingElse: 1});
    expect(getUpdateRequirement().required).toBe(true);
  });
});

describe('v62 — ② النسخ التلقائي: الاستحقاق والتسمية (منطق نقي)', () => {
  const settings = {
    autoBackupEnabled: true,
    autoBackupEveryDays: 1,
  };

  test('أول تشغيل على الإطلاق مستحق فوراً', () => {
    expect(isAutoBackupDue(settings, null, Date.now())).toBe(true);
  });

  test('نسخة ناجحة اليوم ليست مستحقة قبل مرور التواتر', () => {
    const now = Date.now();
    const ledger: AutoBackupLedger = {
      lastRunAt: now - 2 * 3600 * 1000,
      lastPath: 'Downloads/SmartVisionPOS/x.json',
      lastError: null,
      lastProducts: 10,
      lastSales: 5,
    };
    expect(isAutoBackupDue(settings, ledger, now)).toBe(false);
    expect(isAutoBackupDue(settings, ledger, now + DAY + 1000)).toBe(true);
  });

  test('توتر أسبوعي: لا استحقاق قبل السبع أيام', () => {
    const now = Date.now();
    const ledger: AutoBackupLedger = {
      lastRunAt: now,
      lastPath: null,
      lastError: null,
      lastProducts: 1,
      lastSales: 1,
    };
    const weekly = {...settings, autoBackupEveryDays: 7};
    expect(isAutoBackupDue(weekly, ledger, now + 6 * DAY)).toBe(false);
    expect(isAutoBackupDue(weekly, ledger, now + 7 * DAY)).toBe(true);
  });

  test('فشل سابق: إعادة محاولة بعد نصف ساعة لا بعد يوم', () => {
    const now = Date.now();
    const failed: AutoBackupLedger = {
      lastRunAt: now - 40 * 60 * 1000,
      lastPath: null,
      lastError: 'نفدت المساحة',
      lastProducts: 0,
      lastSales: 0,
    };
    expect(isAutoBackupDue(settings, failed, now)).toBe(true);
  });

  test('الإيقاف يلغي الاستحقاق مهما كان الدفتر', () => {
    expect(
      isAutoBackupDue(
        {autoBackupEnabled: false, autoBackupEveryDays: 1},
        null,
        Date.now(),
      ),
    ).toBe(false);
  });

  test('اسم الملف: بادئة ثابتة + تاريخ ووقت قابلان للفرز', () => {
    const name = autoBackupFileName(new Date(2026, 9, 21, 14, 5).getTime());
    expect(name.startsWith(AUTO_BACKUP_PREFIX)).toBe(true);
    expect(name).toBe('sela_auto_backup_2026-10-21_1405.json');
  });
});

describe('v62 — حرّوس المصدر للجولة كاملة', () => {
  test('① شاشة التفعيل تجلب التواصل من /api/v1/config عند الفتح', () => {
    const service = read('src/services/license/LicenseService.ts');
    expect(service).toContain('getServerUrl()}/api/v1/config');
    const screen = read('src/screens/license/ActivationScreen.tsx');
    expect(screen).toContain('fetchServerConfig');
    expect(screen).toContain('loadContact');
    // قسم الاشتراك في الإعدادات أيضاً.
    const settingsSection = read(
      'src/screens/settings/SubscriptionSection.tsx',
    );
    expect(settingsSection).toContain('fetchServerConfig');
  });

  test('② النسخ التلقائي: مكونات كاملة من الجدولة إلى التقليم', () => {
    const native = read(
      'android/app/src/main/java/com/sela/pal/native_modules/PlatformUtilsModule.kt',
    );
    expect(native).toContain('fun pruneAutoBackups');
    expect(native).toContain('fun exportFileSilent');
    expect(native).toContain('MediaStore.MediaColumns.DATE_MODIFIED');
    const app = read('App.tsx');
    expect(app).toContain('startAutoBackupScheduler');
    const settingsStore = read('src/stores/settingsStore.ts');
    expect(settingsStore).toContain('autoBackupEnabled: boolean');
    expect(settingsStore).toContain('autoBackupEnabled: true');
    expect(read('src/services/AutoBackupService.ts')).toContain(
      `AUTO_BACKUP_KEEP_COUNT = ${AUTO_BACKUP_KEEP_COUNT}`,
    );
  });

  test('③ تقرير الكاشير: شبكة بطاقتين بالصف + فلترة وتصفح الفواتير', () => {
    const screen = read('src/screens/reports/CashierReportScreen.tsx');
    expect(screen).toContain("width: '48.5%'");
    expect(screen).toContain('INVOICE_PAGE_SIZE = 20');
    expect(screen).toContain('kindCounts');
    expect(screen).toContain('عرض المزيد');
    expect(screen).toContain('filterChip');
  });

  test('④ بوابة التحديث قبل كل شيء + خادم يوزّع التوجيه', () => {
    const gate = read('src/components/LicenseGate.tsx');
    expect(gate).toContain('getUpdateRequirement');
    expect(gate).toContain('ForceUpdateScreen');
    // واجهة التحديث نفسها غير قابلة للتجاوز (زر تحديث + إعادة فحص).
    const force = read('src/components/ForceUpdateScreen.tsx');
    expect(force).toContain('تحديث التطبيق الآن');
    expect(force).toContain('أعد الفحص');
    // الخادم: كل رد يحمل minAppVersion/updateUrl — يُفحص هنا فقط
    // إن كان المستودع مستنسخاً بجانب التطبيق (فحصه الكامل في CI
    // مستودع الخادم نفسه؛ CI التطبيق لا يستنسخه).
    const serverRoutes = require('fs').existsSync(
      '../sela-license-server/src/routes.js',
    )
      ? read('../sela-license-server/src/routes.js')
      : null;
    if (serverRoutes != null) {
      expect(serverRoutes).toContain('updatePayload');
      expect(serverRoutes).toContain('minAppVersion');
    }
  });

  test('⑤ نافذة الكاشير: تالي/عيون/أخطاء داخلية/إضافة التالي', () => {
    const screen = read('src/screens/settings/CashiersScreen.tsx');
    expect(screen).toContain('returnKeyType="next"');
    expect(screen).toContain("name={revealed ? 'eyeOff' : 'eye'}");
    expect(screen).toContain('إنشاء وإضافة التالي');
    expect(screen).toContain('errors.username');
    expect(screen).toContain('maxDiscountRef');
    expect(screen).toContain('keyboardShouldPersistTaps="handled"');
  });

  test('⑥ الإصدار: 71.0.0 (79)', () => {
    const config = read('src/core/config.ts');
    expect(config).toContain("APP_VERSION = '71.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 79');
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain('versionName "71.0.0"');
    expect(gradle).toContain('versionCode 79');
  });
});
