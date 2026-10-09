/**
 * v43 — الجولة 51: خمسة إصلاحات (محور القيم يمين الرسم، منع فك
 * الربط مع ديون، صلابة فاتورة القسيمة + استرجاع لافتة الإتمام،
 * حذف زر صرف الطرد، منع ازدواج نافذة البيع).
 * ─────────────────────────────────────────────────────────────────
 * ① التقارير: محور القيم (اتجاه القيمة) في أداء المبيعات وساعات
 *    الذروة يُرسم يمين الرسم لا يساره — التطبيق كله RTL.
 * ② فك ربط صِلة ممنوع ما دام هناك ديون على زبائن صِلة المرتبطين
 *    بهذا المتجر (فحص حيّ لحظة الضغط: دفاتر المتجر + خادم صِلة).
 * ③ نظام صرف القسيمة: فشل إنشاء فاتورة البضاعة محلياً بعد نجاح
 *    الصرف لم يعد يُبتلع — «إتمام صرف القسيمة» يفشل بصوت عالٍ
 *    بالسبب، السلة واللافتة تبقيان، وصف الصرف بلا فاتورة يُسترجع
 *    كلافتة إتمام في نقطة البيع عند كل فتح (يشمل إعادة التشغيل).
 * ④ زر «صرف طرد صِلة (بدون سلة)» حُذف من صفحة القسائم مع
 *    ملاحظاته (التلميح، وصف بطاقات الطرود، ورسالة الخطأ في
 *    الخدمة لم تعد تحيل لزر محذوف).
 * ⑤ نافذة البيع/لوحة الوزن لا تفتحان مرتين: إدراج الماسح يفحص
 *    الطابور والنافذة المفتوحة معاً (مرايا refs).
 */
import {freshApp, load} from './helpers/app';

const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

// ── مساعدة القسائم (نفس أدوات vouchers-campaigns) ────────────────

jest.mock('../src/services/sila/SilaApi', () => {
  const actual = jest.requireActual('../src/services/sila/SilaApi');
  class SilaApiError extends Error {
    status: number;
    code: string;
    errorClass: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.name = 'SilaApiError';
      this.status = status;
      this.code = code;
      this.errorClass = 'permanent';
    }
  }
  return {
    ...actual,
    SilaApiError,
    silaRedeemVoucher: jest.fn(),
  };
});

const NO_PRINT = {
  print: false,
  receiptSettings: {} as never,
};

function cartLine(
  product: {id: number; name: string; retail: number; cost: number},
  quantity: number,
) {
  return {
    key: `p${product.id}`,
    productId: product.id,
    name: product.name,
    unitPrice: product.retail,
    costPrice: product.cost,
    retailPrice: product.retail,
    wholesalePrice: product.retail,
    quantity,
    availableStock: 999,
    unitId: null,
    unitName: 'قطعة',
    conversion: 1,
  };
}

async function seedProduct(name: string, retail: number, stock: number) {
  const {ProductRepo} = load('src/database/repositories/ProductRepo');
  const id = await ProductRepo.create({
    name,
    cost_price: retail * 0.6,
    retail_price: retail,
    wholesale_price: retail,
    stock_quantity: stock,
    category_id: null,
    image_uri: null,
  });
  return {id, name, retail, cost: retail * 0.6};
}

function serverAnswer(valueMinor: number) {
  return {
    ok: true,
    reference_code: 'POS-VR-123',
    voucher_id: 'v-1',
    value_minor: valueMinor,
    currency: 'ILS',
    kind: 'voucher' as const,
    campaign_id: 'cmp-school',
    campaign_name: 'حملة المدارس',
    beneficiary_last4: '7878',
    merchant_name: 'متجر الاختبار',
    redeemed_at: new Date().toISOString(),
    settlement: {
      redeemed_value_minor: valueMinor,
      settled_minor: 0,
      due_minor: valueMinor,
      state: 'none' as const,
    },
  };
}

async function seedPairing() {
  const {useSilaStore} = load('src/stores/silaStore');
  useSilaStore.getState().setPairing({
    posToken: 'tok',
    deviceId: 'dev',
    merchantOrgId: 'org',
    merchantName: 'متجر الاختبار',
    tokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
    pairedAt: new Date().toISOString(),
    apiBaseUrl: 'https://sila.example',
  });
}

// ── ① + ② + ④ + ⑤ : حرّوس المصدر ───────────────────────────────

describe('v43 — حرّوس المصدر', () => {
  test('① محور القيم في الرسم على اليمين (أداء المبيعات وساعات الذروة)', () => {
    const chart = read('src/components/charts/BarChart.tsx');
    // البادينغ العريض انتقل لليمين.
    expect(chart).toContain('const paddingLeft = 6;');
    expect(chart).toContain('const paddingRight = 42;');
    expect(chart).not.toContain('const paddingLeft = 42;');
    // التسمية تبدأ من حافة المحور الأيمن وتمتد يميناً.
    expect(chart).toContain('textAnchor="start"');
    expect(chart).toContain('x={width - paddingRight + 6}');
    expect(chart).not.toContain('textAnchor="end"');
  });

  test('② فك الربط محكوم بتسديد الديون أولاً', () => {
    const sila = read('src/screens/sila/SilaScreen.tsx');
    // فحص حيّ لحظة الضغط لا أرقام محمّلة مسبقاً.
    expect(sila).toContain('confirmUnpair = useCallback(async () => {');
    expect(sila).toContain('SilaRepo.storeOwnOutstandingTotal()');
    expect(sila).toContain('SilaRepo.customersOutstandingTotal()');
    // المنع برسالة صريحة بالمبلغ والسبب.
    expect(sila).toContain('لا يمكن فك الربط — عليك تسديد الديون أولاً');
    // الفحص تعذر؟ لا فك على عمياء.
    expect(sila).toContain('تعذر التحقق من الديون');
  });

  test('④ زر صرف الطرد حُذف مع ملاحظاته', () => {
    const tab = read('src/screens/sila/VouchersTab.tsx');
    const sila = read('src/screens/sila/SilaScreen.tsx');
    const service = read('src/services/VoucherService.ts');
    // الزر وتلميحه وحاله ونافذته زالوا — الحارس على صيغة JSX
    // (العنوان كسمة زر) لا على التعليقات التوثيقية.
    expect(tab).not.toContain('title="صرف طرد');
    expect(tab).not.toContain('onOpenParcelRedeem');
    expect(sila).not.toContain('parcelSheetOpen');
    expect(sila).not.toContain('setParcelRefresh');
    // الملاحظات التي كانت تحيل للزر رُتبت — رسالة الخطأ القديمة
    // التي كانت تحيل للزر المحذوف زالت (الحارس على نص الرسالة
    // المستخدم لا على التعليقات التوثيقية).
    expect(tab).not.toContain('تُصرف من زر صرف الطرد هنا فقط');
    expect(tab).not.toContain('طرد — يُصرف من صفحة القسائم');
    expect(service).not.toContain('(زر صرف الطرد)');
    // رسالة الخطأ الجديدة للطرد عند السلة.
    expect(service).toContain(
      'الطرود ليست قسائم شرائية ولا تُصرف من سلة البيع',
    );
  });

  test('⑤ إدراج الماسح مضاد للازدواج — الطابور والنافذة المفتوحة معاً', () => {
    const pos = read('src/screens/PosScreen.tsx');
    // المرايا موجودة ومتزامنة.
    expect(pos).toContain('saleSheetRef');
    expect(pos).toContain('weightProductRef');
    expect(pos).toContain('saleSheetRef.current = saleSheet');
    expect(pos).toContain('weightProductRef.current = weightProduct');
    // الدوال المدمجة في مساري البصري والباركود.
    expect(pos).toContain('const queueSaleSheet = useCallback');
    expect(pos).toContain('const queueWeightPad = useCallback');
    expect(pos.match(/queueSaleSheet\(product\);/g)?.length).toBe(2);
    expect(pos.match(/queueWeightPad\(product\);/g)?.length).toBe(2);
  });
});

// ── ③ : صلابة فاتورة القسيمة + الاسترجاع (وظيفي) ────────────────

describe('v43 — صلابة فاتورة البضاعة واسترجاع لافتة الإتمام', () => {
  test('إتمام الصرف مع مخزون لا يكفي يُرفض بصوت عالٍ ولا فاتورة صامتة', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    await seedPairing();
    const {VoucherService} = load('src/services/VoucherService');
    const {VouchersRepo} = load('src/services/sila/VouchersRepo');
    const {SaleRepo} = load('src/database/repositories/SaleRepo');
    const {silaRedeemVoucher} = load('src/services/sila/SilaApi');

    // قسيمة ٥٠₪ وسلة ٢٠₪ → needsTopUp (الصرف محجوز على الخادم).
    const rice = await seedProduct('أرز', 10, 2);
    (silaRedeemVoucher as jest.Mock).mockResolvedValue(serverAnswer(5000));
    const outcome = await VoucherService.redeemVoucher({
      payload: 'SILA:V1:topup',
      cart: {lines: [cartLine(rice, 2)], discount: 0, pricingMode: 'RETAIL'},
      ...NO_PRINT,
    } as never);
    expect(outcome.needsTopUp).toBe(true);

    // الكاشير أكمل السلة إلى قيمة القسيمة (٥ قطع) لكن المخزون ٢ فقط
    // — الإتمام يفشل بالسبب والفاتورة لا تُنشأ (لم تكن تُنشأ قبل
    // v43 أيضاً لكن بنجاح كاذب صامت!).
    await expect(
      VoucherService.completeCartRedemption(
        outcome.localId,
        {lines: [cartLine(rice, 5)], discount: 0, pricingMode: 'RETAIL'},
        false,
        {} as never,
      ),
    ).rejects.toThrow('فشل إنشاء فاتورة البضاعة');
    expect(await SaleRepo.countAll()).toBe(0);

    // الصف ok بلا فاتورة → لافتة الاسترجاع تحمله (نقطة البيع).
    const incomplete = await VouchersRepo.incompleteCartRedemptions();
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].local_id).toBe(outcome.localId);

    // عالج التاجر السبب (حدّث المخزون) ثم أتمّ — الفاتورة تهبط
    // مرة واحدة بالضبط والقيمة تدخل مبيعات اليوم.
    const {ProductRepo} = load('src/database/repositories/ProductRepo');
    await ProductRepo.setStock(rice.id, 10);
    const completed = await VoucherService.completeCartRedemption(
      outcome.localId,
      {lines: [cartLine(rice, 5)], discount: 0, pricingMode: 'RETAIL'},
      false,
      {} as never,
    );
    expect(completed.sale).not.toBeNull();
    expect(completed.sale!.invoice_number).toMatch(/^INV-V-/);
    expect(completed.sale!.total_amount).toBe(50);
    expect(await SaleRepo.countAll()).toBe(1);
    // اللافتة زالت — لا صف بلا فاتورة بعد الآن.
    expect(await VouchersRepo.incompleteCartRedemptions()).toHaveLength(0);
  });

  test('الصرف المباشر مع فشل حجز الفاتورة يعيد saleBookingFailed بالسبب', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    await seedPairing();
    const {VoucherService} = load('src/services/VoucherService');
    const {VouchersRepo} = load('src/services/sila/VouchersRepo');
    const {SaleRepo} = load('src/database/repositories/SaleRepo');
    const {silaRedeemVoucher} = load('src/services/sila/SilaApi');

    // السلة تساوي القسيمة لكن المخزون لا يكفي — المسار المباشر.
    const rice = await seedProduct('أرز', 10, 1);
    (silaRedeemVoucher as jest.Mock).mockResolvedValue(serverAnswer(5000));
    const outcome = await VoucherService.redeemVoucher({
      payload: 'SILA:V1:direct',
      cart: {lines: [cartLine(rice, 5)], discount: 0, pricingMode: 'RETAIL'},
      ...NO_PRINT,
    } as never);

    // لم يعد نجاحاً كاذباً: التسليم محجوب والسبب واضح.
    expect(outcome.saleBookingFailed).toBe(true);
    expect(outcome.bookingError).toContain('غير كافية');
    expect(outcome.sale).toBeNull();
    expect(await SaleRepo.countAll()).toBe(0);
    // الصف ok (حقيقة الخادم) بلا فاتورة → لافتة الاسترجاع.
    const incomplete = await VouchersRepo.incompleteCartRedemptions();
    expect(incomplete).toHaveLength(1);
  });

  test('قسيمة «أكمل السلة» تُسترجع كلافتة حتى بعد إعادة تشغيل التطبيق', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    await seedPairing();
    const {VoucherService} = load('src/services/VoucherService');
    const {VouchersRepo} = load('src/services/sila/VouchersRepo');
    const {silaRedeemVoucher} = load('src/services/sila/SilaApi');

    const rice = await seedProduct('أرز', 10, 50);
    (silaRedeemVoucher as jest.Mock).mockResolvedValue(serverAnswer(5000));
    const outcome = await VoucherService.redeemVoucher({
      payload: 'SILA:V1:restart',
      cart: {lines: [cartLine(rice, 2)], discount: 0, pricingMode: 'RETAIL'},
      ...NO_PRINT,
    } as never);
    expect(outcome.needsTopUp).toBe(true);

    // «إعادة التشغيل»: اللافتة لم تعد في الذاكرة لكن الصف باقٍ —
    // استعلام الاسترجاع يعيدها (قسيمة شرائية فقط).
    const recovered = await VouchersRepo.incompleteCartRedemptions();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].value_minor).toBe(5000);
    expect(recovered[0].campaign_name).toBe('حملة المدارس');

    // الطرود لا تُسترجع كلافتات إتمام — ليست بضاعة نقطة بيع.
    (silaRedeemVoucher as jest.Mock).mockResolvedValue({
      ...serverAnswer(3000),
      kind: 'parcel',
      campaign_id: 'cmp-parcel',
      campaign_name: 'طرد الشتاء',
    });
    await VoucherService.redeemVoucher({
      payload: 'SILA:V1:parcelrow',
      mode: 'parcel',
      cart: null,
      ...NO_PRINT,
    } as never);
    const afterParcel = await VouchersRepo.incompleteCartRedemptions();
    expect(afterParcel).toHaveLength(1); // القسيمة فقط، الطرد استُبعد.
  });
});
