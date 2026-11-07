/**
 * v81-round94.test.ts — الجولة 94 (نقطة البيع أندرويد + خادم الكاشير):
 * حرّوس طلبات التاجر الدقيقة التي بقيت بعد v80 ضد الانحدار:
 *
 *  ① صفحة التجار: زران بالأيقونة فقط بلا نص — تنزيل الكشف
 *     (تنزيل دفتر التجار PDF) وإضافة تاجر (طلب نصي: «زرين بأيقونة
 *     فقط بلا نص»).
 *  ② نافذة التاجر: زر كشف الـPDF في صف فاتورة التوريد نفسه،
 *     وتعديل/حذف التاجر أيقونتان في رأس النافذة (طلب نصي).
 *  ③ كاشير: فاتورة المرتجع/الاستبدال (RET) تعرض بنودها كاملة —
 *     المرتجع والبدائل بنداً بنداً وقيمتاهما وقناة التسوية
 *     (شكوى التاجر: لا تمييز بين ما رُدّ وما استُبدل).
 *  ④ نقطة البيع: كشف RET يعرض بدائل الاستبدال + خلاصة الفرق.
 *  ⑤ مسامير الإصدار 81.0.0 / 91.
 */
import {readFileSync} from 'fs';
import {join} from 'path';

const R = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('v81 (الجولة 94 #١) — زرا صفحة التجار بالأيقونة فقط', () => {
  test('لا زري نصّ في صف البحث — أيقونتان فقط: تنزيل + إضافة', () => {
    const screen = R('src/screens/merchants/MerchantsScreen.tsx');
    // الأيقونتان الجديدتان بأدوارهما.
    expect(screen).toContain('styles.iconAction');
    expect(screen).toContain('styles.iconActionPrimary');
    // تنزيل الكشف (الدفتر) موصول بأيقونة التنزيل.
    expect(screen).toMatch(
      /onPress=\{exportMerchantsBook\}[^]*?<Icon name="download"/,
    );
    // إضافة التاجر موصولة بأيقونة الزائد.
    expect(screen).toMatch(
      /onPress=\{\(\) => setAddOpen\(true\)\}[^]*?<Icon name="plus"/,
    );
    // الأزرار النصية القديمة زالت.
    expect(screen).not.toContain('title="تنزيل الدفتر"');
    expect(screen).not.toContain('title="تاجر جديد"');
  });
});

describe('v81 (الجولة 94 #٣) — نافذة التاجر حسب الطلب النصي', () => {
  test('كشف الـPDF في صف فاتورة التوريد نفسه', () => {
    const screen = R('src/screens/merchants/MerchantsScreen.tsx');
    expect(screen).toContain('styles.primaryRow');
    // الفاتورة والكشف جنباً إلى جنب في الصف الواحد.
    expect(screen).toMatch(
      /styles\.primaryRow\}[^]*?title="فاتورة توريد جديدة"[^]*?title="كشف PDF"/,
    );
    // لا زر كشف مستقل بحجم كامل بعد الآن.
    expect(screen).not.toContain('title="كشف حساب PDF قابل للطباعة"');
  });

  test('تعديل/حذف التاجر أيقونتان في رأس النافذة', () => {
    const screen = R('src/screens/merchants/MerchantsScreen.tsx');
    // زرا الهيدر موجودان وواصلان.
    expect(screen).toContain('styles.headerIconBtn');
    expect(screen).toContain('styles.headerIconBtnDanger');
    expect(screen).toMatch(
      /onPress=\{\(\) => openEdit\(detail\)\}[^]*?<Icon name="edit"/,
    );
    expect(screen).toMatch(
      /onPress=\{\(\) => removeMerchant\(detail\)\}[^]*?<Icon name="trash"/,
    );
    // صف الإدارة النصي السفلي زال كلياً.
    expect(screen).not.toContain('تعديل البيانات');
    expect(screen).not.toContain('حذف التاجر');
    expect(screen).not.toContain('styles.adminRow');
  });
});

describe('v81 (الجولة 94 #٤) — كاشير: تفاصيل فاتورة المرتجع/الاستبدال', () => {
  test('GET /api/invoice?id= لفاتورة RET يرد البنود كاملة', () => {
    const handlers = R('src/services/lan/LanHandlers.ts');
    // المسار الخاص بفاتورة RET قبل prepareReturn (الذي يرفضها).
    expect(handlers).toContain('returnByNumber(sale.invoice_number)');
    expect(handlers).toContain('SaleRepo.returnItems(ret.id)');
    expect(handlers).toContain('SaleRepo.returnExchanges(ret.id)');
    expect(handlers).toContain('returnLines: retLines.map');
    expect(handlers).toContain('exchangeLines: exchangeLines.map');
    // حقول التفكيك: نوع الاستبدال وقيمتاه والقناة والفاتورة الأصل.
    expect(handlers).toContain('isExchange: ret.is_exchange === 1');
    expect(handlers).toContain('refundMinor: ret.refund_minor');
    expect(handlers).toContain('exchangeMinor: ret.exchange_minor');
    expect(handlers).toContain("refundChannel: ret.refund_channel ?? 'cash'");
    expect(handlers).toContain('originalRef: ret.invoice_ref');
    expect(handlers).toContain('originalTotal: original?.total_amount ?? null');
  });

  test('GET /api/invoices يميّز الاستبدال ويحمل القيمتين والأصل', () => {
    const handlers = R('src/services/lan/LanHandlers.ts');
    // الانضمام لsale_returns في قائمة الفواتير.
    expect(handlers).toContain(
      'LEFT JOIN sale_returns sr ON sr.return_number = s.invoice_number',
    );
    expect(handlers).toContain(
      'isExchange: isReturn && Number(row.is_exchange ?? 0) === 1',
    );
    expect(handlers).toContain(
      'refundMinor: isReturn ? Number(row.refund_minor ?? 0) : 0',
    );
    expect(handlers).toContain(
      'exchangeMinor: isReturn ? Number(row.exchange_minor ?? 0) : 0',
    );
    expect(handlers).toContain(
      'originalRef: isReturn && row.original_ref ? String(row.original_ref) : null',
    );
  });

  test('GET /api/invoice-by-number يحمل isExchange/originalRef لباركود RET', () => {
    const handlers = R('src/services/lan/LanHandlers.ts');
    expect(handlers).toContain(
      'SELECT is_exchange, invoice_ref FROM sale_returns WHERE return_number = ?',
    );
    expect(handlers).toContain('isExchange,');
    expect(handlers).toContain('originalRef,');
  });
});

describe('v81 (الجولة 94 #٥) — نقطة البيع: بدائل الاستبدال في كشف RET', () => {
  test('retContext يحمل بدائل الاستبدال ويحمّلها من المستودع', () => {
    const invoices = R('src/screens/invoices/InvoicesScreen.tsx');
    expect(invoices).toContain('exchanges: SaleReturnExchange[]');
    expect(invoices).toContain('SaleRepo.returnExchanges(ret.id)');
  });

  test('عرض بنود البدائل + خلاصة القيمتين والفرق + قناة التسوية', () => {
    const invoices = R('src/screens/invoices/InvoicesScreen.tsx');
    expect(invoices).toContain('بدائل الاستبدال — خرجت من المخزن بدل المرتجع');
    expect(invoices).toContain('styles.retSummaryNote');
    expect(invoices).toContain('قيمة المرتجع');
    expect(invoices).toContain('قيمة البدائل');
    expect(invoices).toContain('يُرَد للزبون');
    expect(invoices).toContain('يدفع الزبون فرقاً');
    expect(invoices).toContain(
      'paymentMethodById(retContext.ret.refund_channel).label',
    );
  });
});

describe('v81 — الإصدار', () => {
  test('config.ts وbuild.gradle عند 81.0.0 / 91', () => {
    const config = R('src/core/config.ts');
    expect(config).toContain("APP_VERSION = '81.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 91');
    const gradle = R('android/app/build.gradle');
    expect(gradle).toContain('versionName "81.0.0"');
    expect(gradle).toContain('versionCode 91');
  });
});
