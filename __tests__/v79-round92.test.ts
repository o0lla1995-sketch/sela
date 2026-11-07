/**
 * v79 — الجولة 92: إصلاح جوهري في التجار + الكاشير + التنزيل.
 * ─────────────────────────────────────────────────────────────────
 *  ١. «تعذر حفظ الفاتورة: NOT NULL constraint failed:
 *     merchant_movements.created_at» — الإدراجات الأربعة كانت تمرر
 *     NULL صريحاً لعمود NOT NULL DEFAULT (الافتراضي لا يُطبق إلا
 *     عند غياب العمود) — الآن طابع زمني محلي دائماً.
 *  ٢. «زر إضافة دين مستحق مباشر للتجار بدون فاتورة» — نوع حركة
 *     خامس (debt) يرفع المستحق بلا بنود وبلا حركة خزينة، مع
 *     ترحيل v36 يعيد بناء جدول الحركات بقيد CHECK موسّع.
 *  ٣. «تنزيل كشف حساب للتاجر أو التجار ككل» — كشف التاجر الكامل
 *     بالرصيد الجاري + دفتر التجار بسطر لكل تاجر، Excel وCSV.
 *  ٤. «تحسين نوافذ التجار بشكل احترافي» — شارات أنواع ملونة في
 *     الكشف، إجمالي السطر حياً في محرر الفاتورة، اتصال مباشر،
 *     أزرار موزعة في صفوف منطقية.
 *  ٥. الكاشير: فاتورة بنك/محفظة كانت تُسجَّل نقدياً دائماً — خادم
 *     نقطة البيع يهمل paymentMethod؛ الآن تُخزّن القناة الفعلية
 *     وتُعاد مع أرشيف الفواتير للكاشير.
 */
import {describe, expect, test} from '@jest/globals';
import {readFileSync} from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8') as string;

const MERCHANT_REPO = 'src/database/repositories/MerchantRepo.ts';
const MERCHANT_SCREEN = 'src/screens/merchants/MerchantsScreen.tsx';
const CONNECTION = 'src/database/connection.ts';
const EXPORT_SERVICE = 'src/services/ExportService.ts';
const LAN = 'src/services/lan/LanHandlers.ts';
const REPORTS = 'src/screens/reports/ReportsScreen.tsx';
const BACKUP = 'src/services/BackupService.ts';
const CONFIG = 'src/core/config.ts';
const GRADLE = 'android/app/build.gradle';

describe('v79 — ١ جذر خطأ created_at في حركات التجار', () => {
  test('لا يبقى NULL صريح لعمود created_at في أي إدراج', () => {
    const repo = read(MERCHANT_REPO);
    expect(repo).not.toContain('input.createdAt ?? null');
    // الطابع المحلي بديلاً عن NULL في الإدراجات الأربعة كلها.
    const matches = repo.match(/\?\? localNow\(\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });

  test('الطابع الزمني المحلي مستورد من format', () => {
    const repo = read(MERCHANT_REPO);
    expect(repo).toContain("import {localNow, localToday} from '../../core/format'");
  });
});

describe('v79 — ٢ الدين المستحق المباشر بلا فاتورة', () => {
  test('نوع خامس debt في المستودع مع دالة إضافة مخصصة', () => {
    const repo = read(MERCHANT_REPO);
    expect(repo).toContain("| 'debt'");
    expect(repo).toContain('async addDirectDebt(');
    expect(repo).toContain("?, 'debt', ?, ?, ?");
    expect(repo).toContain("debt: 'دين'");
  });

  test('الدين يرفع الرصيد في القائمة والكشف والرصيد اللحظي', () => {
    const repo = read(MERCHANT_REPO);
    expect(repo).toContain("SUM(CASE WHEN kind = 'debt' THEN amount ELSE 0 END)");
    expect(repo).toContain("kind IN ('invoice', 'debt')");
    expect(repo).toContain("SUM(CASE WHEN kind IN ('invoice', 'debt') THEN amount ELSE -amount END)");
    expect(repo).toContain('debtsInRange');
  });

  test('ترحيل v36 يعيد بناء الجدول بقيد CHECK موسّع', () => {
    const connection = read(CONNECTION);
    expect(connection).toContain('if (version < 36)');
    expect(connection).toContain('merchant_movements_v36');
    expect(connection).toContain(
      "kind IN ('invoice','payment','return','collection','debt')",
    );
    // قيد DDL للتثبيت الجديد يشمل الدين أيضاً.
    expect(connection).toContain(
      "CHECK (kind IN ('invoice','payment','return','collection','debt'))",
    );
  });

  test('زر الدين المستحق في نافذة حركة التاجر', () => {
    const screen = read(MERCHANT_SCREEN);
    expect(screen).toContain("{key: 'debt', label: 'دين مستحق', icon: 'book'}");
    expect(screen).toContain("MerchantRepo.addDirectDebt");
    expect(screen).toContain("financeKind === 'debt'");
    expect(screen).toContain("'تسجيل الدين المستحق'");
    expect(screen).toContain("KIND_LABELS[row.movement.kind]");
  });

  test('النسخ الاحتياطي يتقبل نوع الدين', () => {
    const backup = read(BACKUP);
    expect(backup).toContain(
      "kind: 'invoice' | 'payment' | 'return' | 'collection' | 'debt'",
    );
  });
});

describe('v79 → v80 (الجولة 93) — ٣ كشوف التجار PDF بدل Excel/CSV', () => {
  test('خدمة PDF كاملة تحل محل تصدير Excel/CSV الملغى', () => {
    const service = read(
      'src/services/MerchantsPdfService.ts',
    );
    expect(service).toContain('exportStatementPdf');
    expect(service).toContain('exportBookPdf');
    expect(service).toContain('دين مستحق مباشر');
    // ExportService لم يعد يصدّر كشوف التجار نهائياً («لغيهما»).
    const exportService = read(EXPORT_SERVICE);
    expect(exportService).not.toContain('exportMerchantStatement');
    expect(exportService).not.toContain('exportMerchantsBook');
  });

  test('زر كشف PDF في صفحة التاجر وزر الدفتر في الرئيسية', () => {
    const screen = read(MERCHANT_SCREEN);
    // v81 (الجولة 94 #٣): زر «كشف PDF» في صف فاتورة التوريد نفسه،
    // وحوار التنزيل يصف الوثيقة بأنها قابلة للطباعة.
    expect(screen).toContain('title="كشف PDF"');
    expect(screen).toContain('PDF قابل للطباعة');
    expect(screen).toContain('exportMerchantStatement');
    expect(screen).toContain('exportMerchantsBook');
    // خيارات PDF: تنزيل ومشاركة وطباعة — لا Excel ولا CSV.
    expect(screen).toContain("'تنزيل الـPDF'");
    expect(screen).toContain("'مشاركة'");
    expect(screen).toContain("'طباعة'");
    expect(screen).not.toContain("'ملف Excel'");
    expect(screen).not.toContain("'ملف CSV'");
  });
});

describe('v79 — ٤ النوافذ الاحترافية', () => {
  test('شارات أنواع ملونة في كشف الحساب', () => {
    const screen = read(MERCHANT_SCREEN);
    expect(screen).toContain('KIND_TONES');
    expect(screen).toContain('styles.kindBadge');
  });

  test('إجمالي السطر حياً في محرر فاتورة التوريد', () => {
    const screen = read(MERCHANT_SCREEN);
    expect(screen).toContain('إجمالي السطر');
    expect(screen).toContain('styles.itemLineTotal');
  });

  test('اتصال مباشر بالتاجر من صفحته', () => {
    const screen = read(MERCHANT_SCREEN);
    expect(screen).toContain('Linking.openURL');
    expect(screen).toContain('tel:');
  });

  test('تفكيك الدين في بطاقة الرصيد والتقارير', () => {
    expect(read(MERCHANT_SCREEN)).toContain('دين مباشر');
    expect(read(REPORTS)).toContain('ديون مباشرة بالفترة');
    expect(read(REPORTS)).toContain('merchantTotals.debtsInRange');
  });
});

describe('v79 — ٥ الكاشير: القناة الفعلية لا نقدي دائماً', () => {
  test('خادم البيع يقرأ paymentMethod ويتحقق منه', () => {
    const lan = read(LAN);
    expect(lan).toContain('body.paymentMethod');
    expect(lan).toContain('isPaymentMethodId(requested)');
    expect(lan).toContain("'طريقة دفع غير معروفة'");
  });

  test('القناة تنساب إلى InvoiceService.completeSale', () => {
    const lan = read(LAN);
    expect(lan).toContain('paymentMethod,');
  });

  test('أرشيف فواتير الكاشير يعيد paymentMethod', () => {
    const lan = read(LAN);
    expect(lan).toContain('paymentMethod: row.payment_method');
  });
});

describe('v79 — الإصدار', () => {
  test('config.ts وbuild.gradle عند 80.0.0 / 90', () => {
    const config = read(CONFIG);
    expect(config).toContain("APP_VERSION = '81.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 91');
    const gradle = read(GRADLE);
    expect(gradle).toContain('versionName "81.0.0"');
    expect(gradle).toContain('versionCode 91');
  });
});
