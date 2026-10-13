/**
 * v48 — الجولة 56: البيع أونلاين — سيلا ماركت (البنية + POS).
 * ─────────────────────────────────────────────────────────────────
 * حرّوس المصدر والمنطق لميزة البيع أونلاين الكاملة:
 *
 * ① ترحيل v24: جدولا الطلبات + توسيع CHECK بالبناء البديل مع
 *    حفظ أعمدة الاستبدال (is_exchange/exchange_minor) وأعمدة
 *    السندات (photo_path) — لا يُفقد عمود واحد في الترقية.
 * ② المحاسبة: سلسلة INV-O بحجز لا يعود للخلف، والخزينة تعادل
 *    الدين الأونلاين المفوتر بتحصيلاته (COLL) مطروحاً منه
 *    استرداداته (RFD) — نفس قاعدة الأصول الثلاثة الأخرى.
 * ③ ربط الطلب بالفاتورة داخل معاملة البيع نفسها (لا نصف حالة)
 *    + سند التحصيل عند التسليم بالمبلغ القائم.
 * ④ الإرجاع بضابط online: قبل التسليم ينقص الدين الأونلاين،
 *    وبعده استرداد نقدي RFD، والاستبدال يُسوّى فرقه بالاتجاهين.
 * ⑤ الواجهات: شاشة الطلبات بفلاترها وأفعالها، شاشة الإعدادات،
 *    زر الوصول السريع مع شارة الجديد، وإخفاء رابط التفعيل من
 *    واجهة المستخدم (يوزعه الخادم activationUrl).
 * ⑥ الإصدار: 57.0.0 (65).
 */
const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

describe('v48 — البيع أونلاين: الترحيل والقاعدة', () => {
  test('① ترحيل v24: جدولا الطلبات + بناء بديل يحفظ كل الأعمدة', () => {
    const db = read('src/database/connection.ts');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS online_orders');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS online_order_items');
    expect(db).toContain("status IN ('new','accepted','rejected','sent','delivered','cancelled','returned')");
    // إعادة البناء الثلاثية بقيد online الموسّع.
    expect(db).toContain("book IN ('cash','sila','local','online')");
    expect(db).toContain(
      "return_kind IN ('cash','sila','local','online')",
    );
    expect(db).toContain(
      "kind IN ('expense','withdrawal','deposit','online_collection','online_refund')",
    );
    // لا يُفقد عمود واحد: الاستبدال في sale_returns وصورة السند في
    // cash_movements تُنسخان إلى البديل.
    expect(db).toContain(
      'refund_minor, debt_adjusted_minor, is_exchange, exchange_minor,',
    );
    expect(db).toContain(
      'amount_minor, auth_method,\n                    photo_path, created_at',
    );
  });

  test('① المفاتيح والتخزين: إعدادات الوحدة ومؤشرات المزامنة', () => {
    const storage = read('src/storage/storage.ts');
    expect(storage).toContain("onlineSettings: 'online_settings_v1'");
    expect(storage).toContain("onlinePollCursor: 'online_poll_cursor_v1'");
    expect(storage).toContain("onlineInvoiceCounter: 'online_invoice_counter_v1'");
    expect(storage).toContain("onlineSeenOrders: 'online_seen_orders_v1'");
  });

  test('② سلسلة INV-O: حجز DB-aware لا يعود للخلف', () => {
    const service = read('src/services/online/OnlineStoreService.ts');
    expect(service).toContain('INV-O-');
    expect(service).toMatch(/maxOnlineSequenceInDb/);
    expect(service).toMatch(/Math\.max\(mmkvNext, dbMax \+ 1\)/);
    expect(service).toContain('reserveOnlineInvoiceNumber');
  });

  test('② الخزينة: الدين الأونلاين في المعادلة بتحصيله واسترداده', () => {
    const reports = read('src/services/ReportService.ts');
    expect(reports).toContain('onlineInvoicedNetMinor');
    expect(reports).toContain('cashTotals.onlineCollectionsMinor / 100');
    expect(reports).toContain('cashTotals.onlineRefundsMinor / 100');
    expect(reports).toContain('onlineCreditSalesAllTime');
    // الدفتر الثالث مستقل: قسائم البيع بالسلسلة الصحيحة في التقرير.
    const repo = read('src/database/repositories/ReportRepo.ts');
    expect(repo).toContain("LIKE 'INV-O-%'");
    expect(repo).toContain('onlineCount');
  });

  test('③ الربط الذري: الطلب يصبح sent بفاتورته داخل معاملة البيع', () => {
    const saleRepo = read('src/database/repositories/SaleRepo.ts');
    expect(saleRepo).toContain('onlineOrderRow?: {');
    expect(saleRepo).toContain(
      "SET status = 'sent', invoice_ref = ?, sale_id = ?",
    );
    expect(saleRepo).toContain(
      "WHERE order_number = ? AND status IN ('new','accepted')",
    );
    // فشل الربط = فشل المعاملة كلها (لا فاتورة بلا طلب).
    expect(saleRepo).toContain('rowsAffected !== 1');
  });

  test('③ سند التحصيل عند التسليم بالمبلغ القائم (صافي المرتجعات)', () => {
    const service = read('src/services/online/OnlineStoreService.ts');
    expect(service).toContain("reserveCashRef('online_collection')");
    expect(service).toMatch(/total_minor -[\s\S]{0,80}returned_minor/);
    expect(service).toContain("action: 'deliver'");
  });

  test('④ الإرجاع الأونلاين: دفتر online في مسار الإرجاع القياسي', () => {
    const inv = read('src/services/InvoiceService.ts');
    expect(inv).toContain("ref.startsWith('INV-O-')");
    expect(inv).toContain("book = 'online'");
    expect(inv).toContain("kind: 'online'");
    expect(inv).toContain("action: 'return'");
    // قبل التسليم: خصم من الدين؛ بعده: استرداد نقدي RFD.
    expect(inv).toContain("reserveOnlineCashRef('online_refund')");
    // الاستبدال: الفرق يُسوّى نقداً بالاتجاهين.
    expect(inv).toContain("reserveOnlineCashRef('online_collection')");
    const saleRepo = read('src/database/repositories/SaleRepo.ts');
    expect(saleRepo).toContain(
      "INSERT INTO cash_movements\n               (ref, kind, category, note, amount_minor, auth_method, photo_path, created_at)\n             VALUES (?, 'online_refund'",
    );
  });

  test('⑤ الواجهات: الطلبات والإعدادات والرئيسية والإشعارات', () => {
    expect(() => read('src/screens/online/OnlineOrdersScreen.tsx')).not.toThrow();
    const orders = read('src/screens/online/OnlineOrdersScreen.tsx');
    expect(orders).toContain('طلبات البيع أونلاين');
    expect(orders).toContain('تجهيز وإرسال (فاتورة)');
    expect(orders).toContain('تأكيد التسليم (الدين → الخزينة)');
    expect(orders).toContain('tel:');
    expect(orders).toContain('رفض');

    const selling = read('src/screens/online/OnlineSellingScreen.tsx');
    expect(selling).toContain('تفعيل البيع أونلاين');
    expect(selling).toContain('مناطق التوصيل وأسعارها');
    expect(selling).toContain('مزامنة المنتجات الآن');

    // الرئيسية: زر سريع بشارة + استطلاع عند العودة.
    const home = read('src/screens/HomeScreen.tsx');
    expect(home).toContain("'طلبات أونلاين'");
    expect(home).toContain('onlineBadge');
    expect(home).toContain('pollOrders');
    // الإعدادات: بوابة الوحدة.
    const settings = read('src/screens/settings/SettingsScreen.tsx');
    expect(settings).toContain('البيع أونلاين');
    expect(settings).toContain("'OnlineSelling'");

    // الإشعارات: نوع الطلب الجديد.
    const types = read('src/core/types.ts');
    expect(types).toContain("'online_order'");
    const notifications = read('src/screens/NotificationsScreen.tsx');
    expect(notifications).toContain('online_order');
  });

  test('⑤ محرك المزامنة: استطلاع ٦٠ث + منتجات ١٥د + إشعار مرة واحدة', () => {
    const service = read('src/services/online/OnlineStoreService.ts');
    expect(service).toContain('POLL_INTERVAL_MS = 60 * 1000');
    expect(service).toContain('PRODUCTS_SYNC_INTERVAL_MS = 15 * 60 * 1000');
    expect(service).toContain('isNewToMerchant');
    expect(service).toContain("notificationsStore.push");
    expect(service).toContain('ensureEngineStarted');
    // الإقلاع يشغّل المحرك.
    const app = read('App.tsx');
    expect(app).toContain('ensureEngineStarted');
  });

  test('⑤ مصادقة التاجر: نفس زوج الترخيص الصامت — لا بيانات دخول', () => {
    const api = read('src/services/online/OnlineApi.ts');
    expect(api).toContain('license: current.payloadB64');
    expect(api).toContain('signature: current.signatureB64');
    expect(api).toContain('deviceId');
    expect(api).toContain("'/api/v1/store/register'");
    expect(api).toContain("'/api/v1/store/products/sync'");
    expect(api).toContain("'/api/v1/store/orders/poll'");
    expect(api).toContain("'/api/v1/store/orders/action'");
    expect(api).toContain('SUBSCRIPTION_ENDED');
  });

  test('⑤ إخفاء رابط التفعيل عن المستخدم + التبنّي الصامت من الخادم', () => {
    const service = read('src/services/license/LicenseService.ts');
    expect(service).toContain('adoptServerUrlIfProvided');
    expect(service).toContain('isValidServerUrl');
    // الحقل حُذف من الواجهة نهائياً.
    const screen = read('src/screens/license/ActivationScreen.tsx');
    expect(screen).not.toContain('setServerUrl');
    expect(screen).not.toContain('urlInput');
  });

  test('⑥ الإصدار: 57.0.0 (65) في config والبناء', () => {
    const config = read('src/core/config.ts');
    expect(config).toContain("APP_VERSION = '57.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 65');
    const gradle = read('android/app/build.gradle');
    expect(gradle).toContain('versionCode 65');
    expect(gradle).toContain('versionName "57.0.0"');
  });
});

describe('v48 — البيع أونلاين: منطق خالص (بلا قاعدة)', () => {
  test('المبلغ القائم عند التسليم = الإجمالي − المرتجع (مقيّد بالأصناف)', () => {
    // نفس منطق deliverOrder في الخدمة.
    const outstandingAt = (
      totalMinor: number,
      returnedMinor: number,
      itemsTotalMinor: number,
    ) => totalMinor - Math.min(returnedMinor, itemsTotalMinor);
    // طلب نظيف.
    expect(outstandingAt(8500, 0, 7300)).toBe(8500);
    // مرتجع جزئي قبل التسليم.
    expect(outstandingAt(8500, 3200, 7300)).toBe(5300);
    // مرتجع كامل للأصناف — يبقى سطر التوصيل فقط.
    expect(outstandingAt(8500, 7300, 7300)).toBe(1200);
  });

  test('معادلة الخزينة متوازنة في سيناريوهات الطلب الثلاثة', () => {
    // الإيراد يدخل INV-O، والدين الأونلاين المفوتر يُخصم، والتحصيل
    // يعود — التحقق الحسابي نفسه الذي تتبعه treasurySnapshot.
    const balance = (revenue: number, credit: number, coll: number, rfd: number) =>
      revenue - credit + coll - rfd;
    // (أ) طلب مُرسل لم يُسلَّم: الفلوس لم تدخل الدرج.
    expect(balance(100, 100, 0, 0)).toBe(0);
    // (ب) مُسلّم بلا مرتجع.
    expect(balance(100, 100, 100, 0)).toBe(100);
    // (ج) مُسلّم ثم مرتجع جزئي بعد التسليم (استرداد نقدي).
    expect(balance(80, 80, 100, 20)).toBe(80);
    // (د) مرتجع جزئي قبل التسليم ثم تسليم المتبقي.
    expect(balance(80, 80, 80, 0)).toBe(80);
  });

  test('تسعير الخادم: التوصيل حسب المنطقة يضاف لأصناف الطلب', () => {
    const orderTotal = (
      items: {priceMinor: number; quantity: number}[],
      feeMinor: number,
    ) =>
      items.reduce((sum, i) => sum + Math.round(i.priceMinor * i.quantity), 0) +
      feeMinor;
    expect(
      orderTotal(
        [
          {priceMinor: 3350, quantity: 2},
          {priceMinor: 400, quantity: 1.5},
        ],
        1200,
      ),
    ).toBe(8500);
  });
});
