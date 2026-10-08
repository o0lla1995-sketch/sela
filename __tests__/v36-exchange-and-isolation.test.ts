/**
 * v36 — الجولة 44: الاستبدال بقيمة المرجع + عزل المتاجر الجذري (0078).
 * ─────────────────────────────────────────────────────────────────
 * ① الاستبدال (functional, against the REAL services/repos):
 *    • cash book: المرتجع يعود للمخزون والبديل يخرج — والصف المالي
 *      كله أصفار (إيراد/تكلفة/ربح/خزينة لا تتحرك إطلاقاً)،
 *      refund_method 'none' + is_exchange=1 + exchange_minor.
 *    • local debt book: استبدال ضد فاتورة دين — الدين لا يُمس
 *      إطلاقاً (لا خصم ولا حذف): «لا تأثير على العملية المالية».
 *    • صور أصناف الاستبدال + السطر الموجب في فاتورة المرتجع.
 * ② حرّوس المصدر لسلسلة v36/0078 في التطبيق (المزامنة والسقف).
 */
import {freshApp, load} from './helpers/app';

const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

const NO_PRINT = {
  print: false,
  receiptSettings: {
    storeName: 'متجر الاختبار',
    footerText: '',
    width: 58,
    showLogo: false,
    logoPath: null,
  } as never,
};

function line(
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

async function seedProduct(
  name: string,
  retail: number,
  cost: number,
  stock: number,
) {
  const {ProductRepo} = load('src/database/repositories/ProductRepo');
  const id = await ProductRepo.create({
    name,
    cost_price: cost,
    retail_price: retail,
    wholesale_price: retail,
    stock_quantity: stock,
    category_id: null,
    image_uri: null,
  });
  return {id, name, retail, cost};
}

async function stockOf(productId: number): Promise<number> {
  const {ProductRepo} = load('src/database/repositories/ProductRepo');
  const product = await ProductRepo.getById(productId);
  return Number(product?.stock_quantity ?? 0);
}

describe('v36 — الاستبدال بقيمة المرجع (المصفوفة الوظيفية)', () => {
  test('كتاب نقدي: المرتجع يعود والبديل يخرج والصف المالي أصفار بالكامل', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const {SaleRepo} = load('src/database/repositories/SaleRepo');

    const cola = await seedProduct('كولا', 8, 5, 100);
    const water = await seedProduct('مياه', 3, 2, 50);
    const sale = await InvoiceService.completeSale({
      lines: [line(cola, 10)],
      discount: 0,
      paymentType: 'RETAIL',
      ...NO_PRINT,
    } as never);
    expect(await stockOf(cola.id)).toBe(90);
    expect(await stockOf(water.id)).toBe(50);

    const prep = await InvoiceService.prepareReturn(sale.sale.id);
    const ret = await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [
        {
          saleItemId: prep.lines[0].item.id,
          productId: cola.id,
          productName: 'كولا',
          quantity: 4,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 8,
          costPrice: 5,
        },
      ],
      refundMethod: 'none',
      exchange: [
        {
          productId: water.id,
          productName: 'مياه',
          quantity: 10,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 3,
          costPrice: 2,
        },
      ],
      ...NO_PRINT,
    } as never);

    // السجل: استبدال — لا استرداد نقدي، وقيمة البدائل مسجلة.
    expect(ret.is_exchange).toBe(1);
    expect(ret.refund_method).toBe('none');
    expect(ret.refund_minor).toBe(3200); // 4 × 8₪ (قيمة ما عاد للمخزن)
    expect(ret.exchange_minor).toBe(3000); // 10 × 3₪ (قيمة ما خرج بدلاً)

    // المخزون: المرتجع عاد (90→94) والبديل خرج (50→40).
    expect(await stockOf(cola.id)).toBe(94);
    expect(await stockOf(water.id)).toBe(40);

    // المالية: إيراد الخزينة = البيع الأصلي فقط (80₪) — صف المرتجع
    // أصفار فلا يتحرك إيراد ولا ربح ولا خزينة إطلاقاً.
    const revenue = await SaleRepo.allTimeRevenue();
    expect(revenue).toBeCloseTo(80, 5);

    // الفاتورة الأصلية موسومة بقيمة ما رُجع منها (بضاعةً، لا مالاً).
    const original = await SaleRepo.getById(sale.sale.id);
    expect(Number(original?.returned_minor)).toBe(3200);

    // صور أصناف الاستبدال موجودة، وفاتورة المرتجع تحمل سطراً موجباً
    // للبديل (ما خرج) بجانب سطرها السالب (ما عاد).
    const exchanges = await SaleRepo.returnExchanges(ret.id);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].product_name).toBe('مياه');
    expect(exchanges[0].quantity).toBe(10);
    expect(exchanges[0].line_total).toBeCloseTo(30, 5);
    // فاتورة المرتجع (صف sales برقم RET-) — نجيب عليها بمعرّفها.
    const retSaleRow = (await SaleRepo.listRecent(10)).find(
      s => s.invoice_number === ret.return_number,
    );
    expect(retSaleRow).toBeDefined();
    const retItems = await SaleRepo.getItemsForSale(retSaleRow!.id);
    expect(retItems).toHaveLength(2);
    const waterLine = retItems.find(i => i.product_id === water.id);
    const colaLine = retItems.find(i => i.product_id === cola.id);
    expect(waterLine?.quantity).toBe(10); // موجب — خرج من المخزن
    expect(colaLine?.quantity).toBe(-4); // سالب — عاد للمخزن
  });

  test('كتاب دين المتجر: الاستبدال لا يمس الدين إطلاقاً', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');
    const LocalDebts = load('src/database/repositories/LocalDebtsRepo');
    const {LocalDebtsRepo} = LocalDebts;

    const customer = await LocalDebtsRepo.createCustomer({
      name: 'محمد',
      idNumber: '400123456',
      phone: '0561234567',
      notes: null,
    });
    const milk = await seedProduct('حليب', 6, 4, 100);
    const bread = await seedProduct('خبز', 2, 1, 80);
    const sale = await InvoiceService.completeSale({
      lines: [line(milk, 5)],
      discount: 0,
      paymentType: 'RETAIL',
      localDebt: {
        localCustomerId: customer.id,
        customerName: 'محمد',
        customerPhoneLast4: '4567',
      },
      ...NO_PRINT,
    } as never);
    expect(sale.sale.invoice_number).toMatch(/^INV-L-/);
    // الدين = 30₪.
    const before = await LocalDebtsRepo.debtRowByRef(sale.sale.invoice_number);
    expect(Number(before?.amountMinor ?? 0)).toBe(3000);

    const prep = await InvoiceService.prepareReturn(sale.sale.id);
    expect(prep.book).toBe('local');
    const ret = await InvoiceService.createReturn({
      saleId: sale.sale.id,
      lines: [
        {
          saleItemId: prep.lines[0].item.id,
          productId: milk.id,
          productName: 'حليب',
          quantity: 2,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 6,
          costPrice: 4,
        },
      ],
      refundMethod: 'none',
      exchange: [
        {
          productId: bread.id,
          productName: 'خبز',
          quantity: 5,
          unitName: 'قطعة',
          basePerUnit: 1,
          unitPrice: 2,
          costPrice: 1,
        },
      ],
      ...NO_PRINT,
    } as never);

    expect(ret.is_exchange).toBe(1);
    expect(ret.debt_adjusted_minor).toBe(0);
    // «لا تأثير على العملية المالية»: الدين كما هو تماماً — 30₪.
    const after = await LocalDebtsRepo.debtRowByRef(sale.sale.invoice_number);
    expect(after).not.toBeNull();
    expect(Number(after!.amountMinor)).toBe(3000);
    // المخزون: الحليب عاد (95→97) والخبز خرج (80→75).
    expect(await stockOf(milk.id)).toBe(97);
    expect(await stockOf(bread.id)).toBe(75);
  });

  test('مخزون الاستبدال غير الكافي يُرفض برسالة عربية واضحة', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {InvoiceService} = load('src/services/InvoiceService');

    const cola = await seedProduct('كولا', 8, 5, 100);
    const scarce = await seedProduct('نادر', 3, 1, 2); // مخزونه 2 فقط
    const sale = await InvoiceService.completeSale({
      lines: [line(cola, 10)],
      discount: 0,
      paymentType: 'RETAIL',
      ...NO_PRINT,
    } as never);
    const prep = await InvoiceService.prepareReturn(sale.sale.id);
    await expect(
      InvoiceService.createReturn({
        saleId: sale.sale.id,
        lines: [
          {
            saleItemId: prep.lines[0].item.id,
            productId: cola.id,
            productName: 'كولا',
            quantity: 4,
            unitName: 'قطعة',
            basePerUnit: 1,
            unitPrice: 8,
            costPrice: 5,
          },
        ],
        refundMethod: 'none',
        exchange: [
          {
            productId: scarce.id,
            productName: 'نادر',
            quantity: 5, // أعلى من المتوفر 2
            unitName: 'قطعة',
            basePerUnit: 1,
            unitPrice: 3,
            costPrice: 1,
          },
        ],
        ...NO_PRINT,
      } as never),
    ).rejects.toThrow(/لا يكفي للاستبدال/);
    // ولا شيء تغيّر إطلاقاً (المعاملة كلها تراجعت).
    expect(await stockOf(cola.id)).toBe(90);
    expect(await stockOf(scarce.id)).toBe(2);
  });
});

describe('v36 — حرّوس عزل المتاجر الجذري (0078) في التطبيق', () => {
  const SILA_SCREEN = 'src/screens/sila/SilaScreen.tsx';
  const SILA_SYNC = 'src/services/sila/SilaSync.ts';
  const SILA_REPO = 'src/services/sila/SilaRepo.ts';
  const INVOICES = 'src/screens/invoices/InvoicesScreen.tsx';

  test('المزامنة: إعادة التأسيس الأحادية على الأرقام النقية + تدقيق شامل ثانٍ', () => {
    const src = read(SILA_SYNC);
    expect(src).toContain('RECONCILE_V36_REBASE_FLAG');
    expect(src).toContain('v36RebasePass');
    expect(src).toContain('deviceResetFirstPass || v36RebasePass');
    expect(src).toContain('تصحيح عزل المتاجر الجذري (0078)');
    // التدقيق v36 يعيد مسح كل زبائن الكاش على الأرقام النقية.
    expect(src).toContain('if (v36RebasePass) {');
  });

  test('رفع السدادّات: AMOUNT_EXCEEDS_DEVICE_DEBT عابر (12 محاولة) لا دائم', () => {
    const src = read(SILA_SYNC);
    expect(src).toContain("'AMOUNT_EXCEEDS_DEVICE_DEBT'");
    expect(src).toContain('row.retry_count >= 12');
  });

  test('نصيحة الخطأ الجديد بالعربية + ديون المتجر غير المرفوعة للسقف', () => {
    const api = read('src/services/sila/SilaApi.ts');
    expect(api).toContain("case 'AMOUNT_EXCEEDS_DEVICE_DEBT':");
    expect(api).toContain('كاشير متجرك يحصّل ديون متجرك فقط');

    const repo = read(SILA_REPO);
    expect(repo).toContain('pendingUnsyncedOwnDebtMinor');
    expect(repo).toContain("state IN ('pending','syncing')");

    const screen = read(SILA_SCREEN);
    expect(screen).toContain('serverCapMinor + pendingUnsyncedMinor');
  });

  test('نافذة الإرجاع: زر الاستبدال + النافذة + حارس القيمة', () => {
    const src = read(INVOICES);
    expect(src).toContain('الاستبدال بقيمة المرجع');
    expect(src).toContain('function ExchangeSheet');
    expect(src).toContain('قيمة الاستبدال أعلى من قيمة المرتجع');
    expect(src).toContain('بلا أثر مالي');
    // المسح داخل نافذة الاستبدال + الوحدات والمتغيرات.
    expect(src).toContain('UnitRepo.listForProduct');
    expect(src).toContain('VariantRepo.listByProduct');
  });

  test('إيصال الطباعة: قسم البدائل + العبارة «بلا أثر مالي»', () => {
    const src = read('src/services/printer/returnReceipt.ts');
    expect(src).toContain('EXCHANGED ITEMS (out of stock)');
    expect(src).toContain('no financial effect');
    expect(src).toContain('exchanges?: SaleReturnExchange[]');
  });
});
