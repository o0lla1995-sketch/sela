/**
 * v73 — الجولة 85: تعديل الفاتورة عبر نقطة البيع (أندرويد + سطح المكتب).
 * ─────────────────────────────────────────────────────────────────
 * طلب التاجر نصاً:
 * «اولا لماذا عند الضغط علي زر استرجاع الفاتورة السابقة ويتم التعديل
 *  عليها بإضافة او حذف منتجات واتمام عملية البيع يقوم بانشاء فاتورة
 *  جديدة وعملية جديدة بمعني انه لم يعتبر انه المستخدم يريد الرجوع الي
 *  الفاتورة السابقة وتعديلها مثلا و وكانها لم تسجل بعد حيث يستطيع
 *  تعديل المنتجات التي في السلة آو طريقة الدفع أو اضافة خصم وغيرها
 *  بعد الاسترجاع يعني يتم الغاء الفاتورة السابقة ويسجلها من جديد بعد
 *  إجراء التعديلات المطلوبة علي هذه الفاتورة.
 *  ثانيا ... عند مسح فاتورة بالباركود سابقة قديمة آو قام من صفحة
 *  الفواتير بعد فتح الفاتورة وضغط علي زر إرجاع/ استبدال يقوم بفتح
 *  الفاتورة في نقطة البيع مباشرتا بدلا من نافذة الارجاع والاستبدال
 *  ويستطيع الارجاع والاستبدال فيها ... مع الحفاظ علي منطق العمليات
 *  التي تتم في عملية الارجاع و الاستبدال من الخصم والارجاع الي
 *  المخزون وغيرها».
 *
 * التصميم: جلسة تعديل فاتورة (InvoiceEditSession) — الفاتورة تُفتح في
 * السلة من الكميات المتبقية بأسعارها الأصلية، وعند الإتمام تُستبدل
 * الفاتورة الأصلية بالنسخة المعدلة داخل معاملة واحدة (نفس الرقم، بلا
 * فاتورة جديدة تداخلها): طيّ المرتجعات السابقة (حذف صفوف RET مع حفظ
 * لقطة كاملة في sale_edits) + فرق المخزون + إعادة كتابة الصف والبنود +
 * تسوية الدفتر (نقدي: طريقة الدفع؛ دفتر المتجر: صف الدين = الإجمالي
 * الجديد؛ صِلة معلق: صف الطابور؛ صِلة متزامن: سند عكس أو دين زيادة).
 */
const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;

const CONNECTION = 'src/database/connection.ts';
const SALE_REPO = 'src/database/repositories/SaleRepo.ts';
const INVOICE_SERVICE = 'src/services/InvoiceService.ts';
const CART_STORE = 'src/stores/cartStore.ts';
const TYPES = 'src/core/types.ts';
const POS = 'src/screens/PosScreen.tsx';
const INVOICES = 'src/screens/invoices/InvoicesScreen.tsx';
const RECEIPT = 'src/services/printer/receipt.ts';
const DEBT_RECEIPT = 'src/services/printer/debtReceipt.ts';
const CONFIG = 'src/core/config.ts';
const GRADLE = 'android/app/build.gradle';

describe('v73 — ١ المخطط: أعمدة التعديل + سجل التدقيق', () => {
  test('عمودا edit_count/edited_at على sales (DDL + ترحيل v34)', () => {
    const src = read(CONNECTION);
    // DDL للتثبيتات الجديدة.
    expect(src).toContain('edit_count INTEGER NOT NULL DEFAULT 0');
    expect(src).toContain('edited_at TEXT');
    // ترحيل v34 محروس بpragma (idempotent).
    expect(src).toContain('ترحيل v34');
    expect(src).toContain(
      "FROM pragma_table_info('sales') WHERE name = 'edit_count'",
    );
    expect(src).toContain('version = 34');
  });

  test('جدول sale_edits — لقطة قبل/بعد لكل تعديل (المحاسب يرى التاريخ)', () => {
    const src = read(CONNECTION);
    expect(src).toContain('CREATE TABLE IF NOT EXISTS sale_edits');
    expect(src).toContain('before_json TEXT NOT NULL');
    expect(src).toContain('after_json TEXT NOT NULL');
    expect(src).toContain('delta_minor INTEGER NOT NULL DEFAULT 0');
    expect(src).toContain('idx_sale_edits_sale');
  });

  test('النوع يحمل الجلسة وحقلي الفاتورة', () => {
    const types = read(TYPES);
    expect(types).toContain('export interface InvoiceEditSession');
    expect(types).toContain("book: 'cash' | 'sila' | 'local' | 'online'");
    expect(types).toContain('priorReturnsCount: number');
    expect(types).toContain('priorRefundedMinor: number');
    expect(types).toContain('edit_count?: number');
    expect(types).toContain('edited_at?: string | null');
  });
});

describe('v73 — ٢ rewriteSale: الاستبدال داخل معاملة واحدة', () => {
  test('طيّ المرتجعات السابقة: حذف صف RET السالب وإيصاله وصوره', () => {
    const src = read(SALE_REPO);
    // صف RET في sales يُحذف بشرط return_kind (لا يلمس الأصلية أبداً).
    expect(src).toContain(
      'DELETE FROM sales WHERE invoice_number = ? AND return_kind IS NOT NULL',
    );
    expect(src).toContain('DELETE FROM sale_return_items WHERE return_id = ?');
    expect(src).toContain('DELETE FROM sale_returns WHERE id = ?');
    // حرس الجلسة: مرتجع جديد أثناء التعديل يرفض الإتمام.
    expect(src).toContain('أعد فتح تعديل الفاتورة من جديد');
  });

  test('فرق المخزون بين الجديد والصافي المتبقي (الأصل − المرتجع)', () => {
    const src = read(SALE_REPO);
    expect(src).toContain('const remaining = qty - returned;');
    // زيادة بشرط توفر + نقص يعود للأرفف.
    expect(src).toContain(
      'stock_quantity - ? WHERE id = ? AND stock_quantity >= ?',
    );
    expect(src).toContain(
      'UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?',
    );
  });

  test('إعادة كتابة الصف: edit_count/edited_at/returned_minor=0', () => {
    const src = read(SALE_REPO);
    expect(src).toContain('edit_count = ?, edited_at = ?, returned_minor = 0');
  });

  test('تسوية الدفتر: المحلي = الإجمالي الجديد، والمتزامن بالفرق', () => {
    const src = read(SALE_REPO);
    // دفتر المتجر: صف الدين = الإجمالي الجديد (صفر → حذف).
    expect(src).toContain(
      'UPDATE local_debts SET amount_minor = ? WHERE id = ?',
    );
    expect(src).toContain("'sale'");
    // صِلة متزامن: adjustment = الجديد − الأصل + كل عكوس الفاتورة
    //   (مرتجعات مطوية + تعديلات سابقة — تصحيح التعديلات المتتالية).
    expect(src).toContain('priorEditsReversalMinor');
    expect(src).toContain('-RVS${editCountAfter}');
    expect(src).toContain("'return_reversal'");
    expect(src).toContain('-ED');
    // صِلة معلق: الصف نفسه يُعدَّل.
    expect(src).toContain(
      'UPDATE sila_debt_queue',
    );
  });

  test('لقطة قبل/بعد كاملة في sale_edits', () => {
    const src = read(SALE_REPO);
    expect(src).toContain('INSERT INTO sale_edits');
    expect(src).toContain('before_json');
    expect(src).toContain('after_json');
  });
});

describe('v73 — ٣ خدمة التعديل: تحضير + إتمام + فرق الأونلاين', () => {
  test('prepareInvoiceEdit: فحوصات الإرجاع نفسها + بناء الأسطر المتبقية', () => {
    const src = read(INVOICE_SERVICE);
    expect(src).toContain('prepareInvoiceEdit');
    // INV-L بلا دين قائم يُرفض بوضوح.
    expect(src).toContain('دين هذه الفاتورة مسدَّد/محذوف من الدفتر');
    // الجلسة تحمل الدفتر والأصل والمرتجعات السابقة.
    expect(src).toContain('priorReturnsCount: prep.returnsSoFar.length');
    expect(src).toContain('originalPaymentMethod: sale.payment_method ?? null');
  });

  test('settleInvoiceEdit: سلة فارغة = إرجاع كامل بالمحرك القائم', () => {
    const src = read(INVOICE_SERVICE);
    expect(src).toContain('settleInvoiceEdit');
    expect(src).toContain('إرجاع كامل عبر تعديل الفاتورة');
  });

  test('أونلاين: تسوية مركبة — إرجاع الناقص + بيع الإضافي', () => {
    const src = read(INVOICE_SERVICE);
    expect(src).toContain('diffCartVsInvoice');
    expect(src).toContain('online-composed');
  });

  test('صِلة متزامن: مفاتيح التكرار + المرجع البنيوي + دفع فوري', () => {
    const src = read(INVOICE_SERVICE);
    expect(src).toContain('uuidV4()');
    expect(src).toContain('SilaSync.syncNow()');
    // المرجع البنيوي داخل المعاملة — التعديلات التالية تحسبه ضمن
    // عكوس الفاتورة (تصحيح التعديلات المتتالية على دين متزامن).
    const repo = read(SALE_REPO);
    expect(repo).toContain('${invoiceNumber}-RVS%');
    expect(repo).toContain('-RVS${editCountAfter}');
    expect(repo).toContain('priorEditsReversalMinor');
  });

  test('بناء أسطر التعديل من قاعدة البيانات (يشمل المؤرشف)', () => {
    const src = read(INVOICE_SERVICE);
    expect(src).toContain('buildInvoiceEditLines');
    expect(src).toContain('ProductRepo.getById');
  });
});

describe('v73 — ٤ السلة: الجلسة تنجو مع المسودة', () => {
  test('editSession + beginEdit/cancelEdit في المخزن', () => {
    const src = read(CART_STORE);
    expect(src).toContain('editSession: InvoiceEditSession | null;');
    expect(src).toContain('beginEdit: (');
    expect(src).toContain('cancelEdit: (');
    // المسودة تحفظ الجلسة — قتل التطبيق لا يفقدها.
    expect(src).toContain('editSession: session,');
  });

  test('التفريغ والنسخ كسلة جديدة يسقطان الجلسة (لا فاتورة معلقة)', () => {
    const src = read(CART_STORE);
    // clear
    expect(src).toContain(
      'set({lines: [], discount: 0, editSession: null});',
    );
    // restoreLines (النسخ لسلة جديدة) يسقط الجلسة أيضاً.
    expect(src).toMatch(
      /restoreLines[\s\S]*?editSession: null,\n    \}\);/,
    );
  });
});

describe('v73 — ٥ نقطة البيع: الشريط والماسح والرجوع', () => {
  test('شريط التعديل: الأصل/الجديد/الفرق + إتمام/إلغاء', () => {
    const src = read(POS);
    expect(src).toContain('تعديل الفاتورة {editSession.invoiceNumber}');
    expect(src).toContain('إتمام التعديل');
    expect(src).toContain('على الزبون +');
    expect(src).toContain('يُرَد للزبون');
  });

  test('زر الرجوع: خياران صريحان — تعديل الأصلية أو نسخها لسلة جديدة', () => {
    const src = read(POS);
    expect(src).toContain('نسخها كسلة جديدة');
    expect(src).toContain('تعديل الفاتورة الأصلية');
    // تخطي RET وINV-V لأقرب فاتورة قابلة للتعديل.
    expect(src).toContain("row.return_kind == null");
    expect(src).toContain("startsWith('INV-V-')");
  });

  test('مسح باركود الفاتورة يفتحها للتعديل (كلا محركي المسح)', () => {
    const src = read(POS);
    // صيغة صارمة: INV-/INV-D-/INV-L-/INV-V-/INV-O-/RET-.
    expect(src).toContain(
      '/^(INV(-[A-Z])?|RET)-\\d{8}-\\d{4}$/.test(code.trim())',
    );
    expect(src).toContain("status: 'invoice-open'");
    // كلا الجلستين (الباركود والمدمجة) تعالجانه بعد إغلاق الماسح:
    // تعريفان (let invoiceScanHit) + استعمالان (if != null).
    expect(src.split('let invoiceScanHit').length - 1).toBe(2);
    expect(src.split('invoiceScanHit != null').length - 1).toBe(2);
  });

  test('أثناء التعديل: زر البيع يفتح نافذة الإتمام والدين الجديد ممنوع', () => {
    const src = read(POS);
    // openPaySheet يحوّل لنافذة التعديل.
    expect(src).toContain('setEditSettleOpen(true)');
    // لا دين جديد أثناء التعديل.
    expect(src).toContain(
      'أثناء تعديل الفاتورة لا يُسجَّل دين جديد',
    );
    // تفريغ السلة أثناء التعديل = إلغاء التعديل بصراحة.
    expect(src).toContain('إلغاء تعديل الفاتورة');
  });

  test('نافذة الإتمام: ملخص الفرق + قناة التسوية + شرح الدفتر', () => {
    const src = read(POS);
    expect(src).toContain('EditSettleSheet');
    expect(src).toContain('تأكيد التعديل واستبدال الفاتورة');
    expect(src).toContain('الفرق يُعدَّل تلقائياً على دين الزبون');
  });
});

describe('v73 — ٦ صفحة الفواتير: الإرجاع/الاستبدال من نقطة البيع', () => {
  test('زر الإرجاع/الاستبدال يفتح الفاتورة في نقطة البيع مباشرة', () => {
    const src = read(INVOICES);
    expect(src).toContain('openInvoiceEditFromInvoices');
    expect(src).toContain("navigation.navigate('Pos')");
    // لا يفتح نافذة الإرجاع القديمة بعد الآن من زر التفصيل.
    expect(src).not.toContain('onPress={() => setReturnOpen(true)}');
  });

  test('وسم «معدلة ×N» في تفصيل الفاتورة', () => {
    const src = read(INVOICES);
    expect(src).toContain('معدلة ×');
  });
});

describe('v73 — ٧ الإيصال: تمييز النسخة المعدلة', () => {
  test('سطر «نسخة معدلة» على إيصال البيع وإيصال الدين', () => {
    expect(read(RECEIPT)).toContain('نسخة معدلة');
    expect(read(DEBT_RECEIPT)).toContain('نسخة معدلة');
    // فقط للفواتير المعدلة فعلاً (edit_count > 0).
    expect(read(RECEIPT)).toContain('(data.sale.edit_count ?? 0) > 0');
    expect(read(DEBT_RECEIPT)).toContain('(data.sale.edit_count ?? 0) > 0');
  });
});

describe('v73 — ٨ الإصدار', () => {
  test('73.0.0 (81) في config والبناء', () => {
    const config = read(CONFIG);
    expect(config).toContain("APP_VERSION = '73.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 81');
    const gradle = read(GRADLE);
    expect(gradle).toContain('versionCode 81');
    expect(gradle).toContain('versionName "73.0.0"');
  });
});
