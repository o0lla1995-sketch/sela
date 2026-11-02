/**
 * v75 — الجولة 87: ثلاث ملاحظات التاجر على نقطة البيع أندرويد.
 * ─────────────────────────────────────────────────────────────────
 *  ١. نظام الإرجاع والاستبدال (تعديل الفاتورة عبر نقطة البيع): بعد
 *     احتساب الفرق واختيار قناة ردّه (محفظة/بنك/نقدي) كان النظام
 *     ينقل كامل قيمة الفاتورة إلى القناة المختارة ويخصمها كاملةً
 *     من القناة الأصلية — بدل تحريك الفرق وحده. النص الأصلي:
 *     «لم يستخدم المحفظة أو البنك لرد او اضافة الفرق فقط بل قام
 *     بنقل كافة قيمة الفاتورة الي المحفظة أو البنك الذي تم
 *     اختياره بعد تعديل الفاتورة».
 *  ٢. نافذة الفاتورة: زر إعادة طباعة أيقونة فقط دون نص.
 *  ٣. الهيدر العلوي غير متجاوب — يبدو أكبر على الشاشات الكبيرة.
 */
import {describe, expect, test} from '@jest/globals';
import {readFileSync} from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8') as string;

const SALE_REPO = 'src/database/repositories/SaleRepo.ts';
const INVOICE_SERVICE = 'src/services/InvoiceService.ts';
const INVOICES = 'src/screens/invoices/InvoicesScreen.tsx';
const THEME = 'src/core/theme.ts';
const UI = 'src/components/ui.tsx';
const CONFIG = 'src/core/config.ts';
const GRADLE = 'android/app/build.gradle';

describe('v75 — ١ فرق التعديل يتحرك وحده (لا كامل الفاتورة)', () => {
  test('rewriteSale: مدخلاته تحمل settleMethod لا paymentMethod', () => {
    const src = read(SALE_REPO);
    expect(src).toContain('settleMethod?: string | null;');
    expect(src).not.toContain('paymentMethod: string | null;\n  /** دفتر الفاتورة');
  });

  test('إعادة الكتابة لا تمس طريقة دفع الفاتورة (تبقى الأصلية)', () => {
    const src = read(SALE_REPO);
    // أمر التحديث في rewriteSale بلا payment_method — الصف يبقى على
    // قنته الأصلية فلا ينتقل تبع الفاتورة كاملاً إلى قناة التسوية.
    const updateIdx = src.indexOf('edit_count = ?, edited_at = ?, returned_minor = 0');
    expect(updateIdx).toBeGreaterThan(0);
    const updateBlock = src.slice(Math.max(0, updateIdx - 400), updateIdx + 60);
    expect(updateBlock).not.toContain('payment_method = ?');
    // ولقطة التدقيق تحفظ الطريقة الأصلية نفسها.
    expect(src).toContain('payment_method: originalPaymentMethod,');
  });

  test('سندا التسوية المتقابلان على القناتين — لا سند عند التساوي', () => {
    const src = read(SALE_REPO);
    // الحجز خارج المعاملة (MMKV خارج tx) للسندين المحتملين.
    expect(src).toContain("await reserveRef('deposit')");
    expect(src).toContain("await reserveRef('withdrawal')");
    // الحرس: نقدية + فرق ≥ 0.01₪ + قناتان مختلفتان + سندان محجوزان.
    expect(src).toContain('maySettleChannels &&');
    expect(src).toContain('Math.abs(editDeltaMinor) >= 1');
    expect(src).toContain('chosenSettleMethod !== originalPaymentMethod');
    // الفئات الثلاث الواضحة للتاجر في كشف القناة.
    expect(src).toContain("'تحصيل فرق تعديل فاتورة'");
    expect(src).toContain("'رد فرق تعديل فاتورة'");
    expect(src).toContain("'تسوية قناة تعديل فاتورة'");
    // السندان داخل معاملة rewriteSale نفسها (ذرية كاملة).
    const txStart = src.indexOf('await db.transaction(async tx => {');
    const firstInsert = src.indexOf('تحصيل فرق تعديل فاتورة');
    const lastInsert = src.indexOf('تسوية قناة تعديل فاتورة');
    expect(txStart).toBeGreaterThan(0);
    expect(firstInsert).toBeGreaterThan(txStart);
    expect(lastInsert).toBeGreaterThan(firstInsert);
  });

  test('الخدمة تمرر القناة المختارة كقناة تسوية فرق فقط', () => {
    const src = read(INVOICE_SERVICE);
    expect(src).toContain('settleMethod: input.paymentMethod,');
  });

  test('المعادلة المحاسبية: كل قناة تطابق كشفها (منطق نقي)', () => {
    // محاكاة دفتر القنوات (methodLedgerTotals) لفاتورة نقدية
    // أصلها 1000₪ عبر محفظة A، عُدلت إلى 800₪ والفرق رُد عبر محفظة B.
    // الحالة القديمة (الخلل): الصف كله ينتقل إلى B:
    //   A: 0 ، B: +800 مبيعات — كامل القيمة انتقلت إلى المختارة.
    // الحالة الجديدة: الصف يبقى على A (800) + سندان متقابلان:
    //   A: 800 مبيعات + 200 إيداع مقابل = +1000 (يطابق ما قبضته فعلاً)
    //   B: 200 سحب = -200 (يطابق ما دفعته فعلاً)
    //   الصافي الكلي: +800 = قيمة الفاتورة المعدلة بالضبط.
    const oldCollected = 1000;
    const newInvoice = 800;
    const delta = newInvoice - oldCollected; // -200 (رد للزبون)
    // دفتر القنوات بعد الإصلاح:
    const ledger: Record<string, number> = {};
    const credit = (ch: string, minor: number) => {
      ledger[ch] = (ledger[ch] ?? 0) + minor;
    };
    // الصف المعاد كتابته على القناة الأصلية بالإجمالي الجديد.
    credit('walletA', newInvoice);
    // سند الرد على القناة المختارة (سحب |الفرق|).
    credit('walletB', delta); // -200
    // المقابل على القناة الأصلية (بقي فيها الفرق لأن الرد جرى من B).
    credit('walletA', -delta); // +200
    expect(ledger.walletA).toBe(1000); // كشف A الفعلي
    expect(ledger.walletB).toBe(-200); // كشف B الفعلي
    expect(ledger.walletA + ledger.walletB).toBe(newInvoice);

    // الاتجاه المعاكس: أصل 800 عبر A، تعديل إلى 1000، الفرق حُصّل عبر B.
    const ledger2: Record<string, number> = {};
    const credit2 = (ch: string, minor: number) => {
      ledger2[ch] = (ledger2[ch] ?? 0) + minor;
    };
    credit2('walletA', 1000); // الصف بالإجمالي الجديد على الأصلية
    credit2('walletB', +200); // إيداع تحصيل الفرق على المختارة
    credit2('walletA', -200); // المقابل: الفرق لم يدخل الأصلية
    expect(ledger2.walletA).toBe(800); // ما قبضته A فعلاً
    expect(ledger2.walletB).toBe(200); // ما قبضته B فعلاً
    expect(ledger2.walletA + ledger2.walletB).toBe(1000);

    // القناتان واحدة → لا سنداً: الصف وحده يوازن المعادلة.
    const ledger3: Record<string, number> = {};
    ledger3.cash = 800; // الصف بالإجمالي الجديد، لا سنداً إطلاقاً
    expect(ledger3.cash).toBe(newInvoice);
  });
});

describe('v75 — ٢ زر إعادة الطباعة أيقونة فقط في نافذة الفاتورة', () => {
  test('الزر مربع أيقوني بحجم شرائح الرأس — بلا نص', () => {
    const src = read(INVOICES);
    expect(src).toContain('reprintIconChip');
    expect(src).toContain('width: 38,');
    expect(src).toContain('accessibilityLabel="إعادة طباعة الفاتورة"');
    expect(src).toContain('name="printer"');
    // لا زر نصي «إعادة الطباعة» في رأس التفصيل بعد الآن.
    expect(src).not.toContain('title="إعادة الطباعة"');
  });

  test('مؤشر تحميل داخل الزر أثناء إعادة الطباعة', () => {
    const src = read(INVOICES);
    expect(src).toContain('{reprinting ? (');
    expect(src).toContain(
      '<ActivityIndicator size="small" color={c.accent} />',
    );
  });
});

describe('v75 — ٣ الهيدر العلوي المتجاوب مع أحجام الشاشات', () => {
  test('مقاييس الهيدر دالة في العرض — تتقلص على الشاشات العريضة', () => {
    const src = read(THEME);
    expect(src).toContain('export function headerMetricsFor');
    expect(src).toContain('dpWidth >= 440 ? 0.95 : 1');
    expect(src).toContain('maxFontSizeMultiplier');
  });

  test('AppHeader يستخدم المقاييس المتجاوبة ويجمّد تضخم الخط', () => {
    const src = read(UI);
    expect(src).toContain('headerMetricsFor(winWidth / PixelRatio.get())');
    expect(src).toContain('{height: hm.rowHeight}');
    expect(src).toContain('maxFontSizeMultiplier={1}');
    // القياسات الثابتة القديمة (58/42) لم تعد في الأنماط الساكنة.
    expect(src).not.toContain('height: 58,');
    expect(src).not.toContain('borderRadius: 21,');
  });
});

describe('v75 — ٤ الإصدار', () => {
  test('76.0.0 (84) في config والبناء', () => {
    expect(read(CONFIG)).toContain("APP_VERSION = '76.0.0'");
    expect(read(CONFIG)).toContain('APP_BUILD_CODE = 84');
    expect(read(GRADLE)).toContain('versionCode 84');
    expect(read(GRADLE)).toContain('versionName "76.0.0"');
  });
});
