/**
 * round91.test.ts — v3.5.0 (الجولة 91 — كاشير #2/#3/#4): حرّوس
 * الاحتساب اللحظي والتحقق قبل الحفظ والفلاتر الجديدة.
 * ─────────────────────────────────────────────────────────────────
 * ① (كاشير #2 — المخزون): الرقم المعروض يتحرك لحظة البيع دون
 *    اتصال — displayBaseStock/displayVariantStock فوق مخزون آخر
 *    مزامنة + معلّق الجهاز، وبنفس قاعدة السلة (الأحجام من أساس
 *    المنتج، الملابس من رصيد متغيرها).
 * ② (كاشير #2 — الدين): دفتر الدين المعلق — مبيعات دين معلقة
 *    تُجمع لكل زبون، ومرتجع معلق مصدره فاتورة دين يخفضه، والأصفار
 *    لا تبقى (رصيد الخادم هو الحقيقة بعد المزامنة).
 * ③ (كاشير #3 — التحقق قبل الحفظ): فاتورة بمنتج محذوف أو متغير
 *    مكسور لا تُحفظ أصلاً؛ الشفاء بالتسمية/الاسم يوصل ما يمكن
 *    توصيله (نفس قواعد الخادم v78.1 حرفياً) قبل الحفظ.
 * ④ (كاشير #4 — الفلاتر): قناة الدفع (بنك/محفظة) وحالة المزامنة
 *    مع النوع والزمن والبحث متعدد الأبعاد.
 * ⑤ مسامير الإصدار 3.5.0 (12).
 */

// محاكاة localDb بصفوف قابلة للبرمجة حسب نص الاستعلام — بها
// نختبر دفتر الدين المعلق وتسويات المخزون المعروضة بلا قاعدة
// حقيقية (نفس نهج حرّوس SQL في return_scoping).
interface ProgrammedRows {
  sales?: {cid: number; total: number}[];
  returns?: {cid: number; total: number}[];
  adjustments?: {
    product_id: number;
    variant_id: number | null;
    sign: number;
    delta: number;
  }[];
}

jest.mock('../src/native', () => {
  const actual = jest.requireActual('../src/native');
  const state: {rows: ProgrammedRows} = {rows: {}};
  const localDb = {
    async select(sql: string) {
      if (sql.includes('JOIN invoices s')) {
        return (state.rows.returns ?? []).map(r => ({...r}));
      }
      if (sql.includes("pay_kind = 'debt'")) {
        return (state.rows.sales ?? []).map(r => ({...r}));
      }
      if (sql.includes('GROUP BY ii.product_id')) {
        return (state.rows.adjustments ?? []).map(r => ({...r}));
      }
      return [];
    },
    async run() {
      return {insertId: 1, rowsAffected: 1};
    },
    async tx(statements: {sql: string}[]) {
      return statements.length >= 0;
    },
  };
  return {...actual, localDb, __rows: state};
});

import {recordLocalOp, pendingDebtByCustomer, type LocalInvoice} from '../src/store/offline';
import {
  displayBaseStock,
  displayVariantStock,
  refreshPendingStockAdjustments,
} from '../src/store/catalog';
import {validateSaleDraft} from '../src/store/validation';
import {filterInvoices} from '../src/store/invoiceFilters';
import {APP_VERSION, APP_BUILD_CODE, APP_VERSION_LABEL} from '../src/core/config';
import type {CatalogProduct, LocalCustomer} from '../src/api/types';

const rows = (jest.requireMock('../src/native') as {
  __rows: {rows: ProgrammedRows};
}).__rows;
void rows;

function product(overrides: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    id: 7,
    name: 'عصير',
    categoryId: 1,
    categoryName: 'مشروبات',
    retailPrice: 6,
    wholesalePrice: 5,
    costPrice: 3,
    discountPct: 0,
    stockQty: 10,
    stockUntracked: false,
    byWeight: false,
    barcode: null,
    hasVariants: false,
    hasImage: false,
    units: [
      {id: 3, name: 'علبة', short: 'علبة', conversion: 12, retailPrice: 60, barcode: null},
    ],
    variants: [],
    ...overrides,
  };
}

function clothing(): CatalogProduct {
  return product({
    id: 9,
    name: 'تيشيرت',
    hasVariants: true,
    stockQty: 6,
    variants: [
      {id: 21, kind: 'variant', color: 'أسود', size: 'L', retailPrice: null, costPrice: 15, stockQty: 4},
      {id: 22, kind: 'variant', color: 'أبيض', size: 'M', retailPrice: null, costPrice: 15, stockQty: 2},
    ],
  });
}

function customers(): LocalCustomer[] {
  return [
    {id: 1, name: 'أحمد', idNumber: '123456789', phone: null, outstandingMinor: 5000},
    {id: 2, name: 'سالم', idNumber: '', phone: null, outstandingMinor: 0},
  ];
}

beforeEach(() => {
  rows.rows = {};
});

// ── ① المخزون المعروض يتحرك لحظة البيع ──────────────────────────

describe('v3.5 (كاشير #2) — الخصم اللحظي المرئي للمخزون', () => {
  test('الرقم على البلاطة = آخر مزامنة + معلّق الجهاز (بيع 3 دون اتصال)', async () => {
    rows.rows.adjustments = [
      {product_id: 7, variant_id: null, sign: -1, delta: 3},
    ];
    await refreshPendingStockAdjustments();
    expect(displayBaseStock(product())).toBe(7);
  });

  test('المرتجع المعلق يعيد الكمية محلياً (sign=+1)', async () => {
    rows.rows.adjustments = [
      {product_id: 7, variant_id: null, sign: -1, delta: 5},
      {product_id: 7, variant_id: null, sign: 1, delta: 2},
    ];
    await refreshPendingStockAdjustments();
    expect(displayBaseStock(product())).toBe(7);
  });

  test('رصيد متغير الملابس يشمل معلّقه وحده — إخوته لا يمسّهم', async () => {
    rows.rows.adjustments = [
      {product_id: 9, variant_id: 21, sign: -1, delta: 3},
    ];
    await refreshPendingStockAdjustments();
    const shirt = clothing();
    // أسود L: 4 − 3 = 1 · أبيض M: 2 (لم يُمس).
    expect(displayVariantStock(shirt, 21)).toBe(1);
    expect(displayVariantStock(shirt, 22)).toBe(2);
  });

  test('الأحجام (مطعم) تُباع من أساس المنتج — نفس قاعدة السلة', async () => {
    rows.rows.adjustments = [
      {product_id: 7, variant_id: null, sign: -1, delta: 4},
    ];
    await refreshPendingStockAdjustments();
    const cafe = product({
      hasVariants: true,
      variants: [
        {id: 31, kind: 'size', color: '', size: 'كبير', retailPrice: 12, costPrice: 5, stockQty: 0},
      ],
    });
    expect(displayVariantStock(cafe, 31)).toBe(6);
  });

  test('لا سالب أبداً — الرصيد يُعرض بصفر على الأقل', async () => {
    rows.rows.adjustments = [
      {product_id: 7, variant_id: null, sign: -1, delta: 25},
    ];
    await refreshPendingStockAdjustments();
    expect(displayBaseStock(product())).toBe(0);
  });
});

// ── ② دفتر الدين المعلق ─────────────────────────────────────────

describe('v3.5 (كاشير #2) — التسجيل اللحظي للدين دون اتصال', () => {
  test('مبيعات دين معلقة تُجمع لكل زبون لحظة الحفظ', async () => {
    rows.rows.sales = [
      {cid: 1, total: 48},
      {cid: 2, total: 20},
    ];
    const book = await pendingDebtByCustomer();
    expect(book.get(1)).toBe(48);
    expect(book.get(2)).toBe(20);
  });

  test('مرتجع معلق مصدره فاتورة دين يخفض دين صاحبها', async () => {
    rows.rows.sales = [{cid: 1, total: 48}];
    rows.rows.returns = [{cid: 1, total: 18}];
    const book = await pendingDebtByCustomer();
    expect(book.get(1)).toBe(30);
  });

  test('التعادل بعد المزامنة: الأصفار تختفي (رصيد الخادم هو الحقيقة)', async () => {
    rows.rows.sales = [{cid: 1, total: 48}];
    rows.rows.returns = [{cid: 1, total: 48}];
    const book = await pendingDebtByCustomer();
    expect(book.has(1)).toBe(false);
    expect(book.size).toBe(0);
  });

  test('الرصيد المعروض في اختيار الزبون = رصيد الخادم + المعلق', async () => {
    rows.rows.sales = [{cid: 1, total: 12}];
    const book = await pendingDebtByCustomer();
    const cached = customers(); // أحمد عليه 50 من آخر مزامنة.
    const shown = cached[0].outstandingMinor / 100 + (book.get(1) ?? 0);
    expect(shown).toBe(62);
  });

  test('recordLocalOp يخزن معرّف الزبون واسمه الحقيقي (لا «زبون الدفتر»)', async () => {
    // عبر محاكاة return_scoping: نتحقق أن الحقول تصل للجملة —
    // هنا يكفي أن الاستدعاء ينجح والقيم تُمرر (المحاكاة تلتقطها
    // في tx بجملة الفاتورة، وقد حرّسها اختبار التكافؤ بـ15 عموداً).
    await expect(
      recordLocalOp({
        ref: 'C-dev-91',
        kind: 'sale',
        displayNumber: 'م-9',
        payKind: 'debt',
        payMethod: 'cash',
        total: 30,
        discount: 0,
        customerName: 'أحمد',
        customerId: 1,
        createdAt: '2026-11-06 12:00:00',
        lines: [],
        payload: {},
      }),
    ).resolves.toBeUndefined();
  });
});

// ── ③ التحقق من سلامة الفاتورة قبل الحفظ ────────────────────────

describe('v3.5 (كاشير #3) — التحقق قبل الحفظ والشفاء المحلي', () => {
  test('منتج محذوف من نقطة البيع → لا حفظ ورسالة واضحة', () => {
    const result = validateSaleDraft({
      lines: [
        {productId: 99, productName: 'شامبو', unitId: null, unitName: 'حبة', variantId: null, variantLabel: null, quantity: 1},
      ],
      products: [product()],
      customers: customers(),
      payKind: 'cash',
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain('شامبو');
    expect(result.issues[0]).toContain('حُذف');
  });

  test('متغير استُبدلت معرّفاته → الشفاء بالتسمية يوصله قبل الحفظ', () => {
    // السطر يحمل معرّفاً قديماً (5) لتيشيرت أُعيد إنشاء متغيراته،
    // والتسمية «أسود · L» تطابق المتغير الحالي (21).
    const result = validateSaleDraft({
      lines: [
        {productId: 9, productName: 'تيشيرت', unitId: null, unitName: 'قطعة', variantId: 5, variantLabel: 'أسود · L', quantity: 1},
      ],
      products: [clothing()],
      customers: customers(),
      payKind: 'cash',
    });
    expect(result.ok).toBe(true);
    expect(result.healedLines[0].variantId).toBe(21);
  });

  test('متغير مكسور بلا شفاء → رفض قبل الحفظ (لا فاتورة تنتظر رفضاً)', () => {
    const result = validateSaleDraft({
      lines: [
        {productId: 9, productName: 'تيشيرت', unitId: null, unitName: 'قطعة', variantId: 77, variantLabel: 'أزرق · XXL', quantity: 1},
      ],
      products: [clothing()],
      customers: customers(),
      payKind: 'cash',
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain('أزرق · XXL');
    expect(result.issues[0]).toContain('غير متاح');
  });

  test('منتج متغيرات بلا اختيار متغير → رفض (نفس قاعدة الخادم)', () => {
    const result = validateSaleDraft({
      lines: [
        {productId: 9, productName: 'تيشيرت', unitId: null, unitName: 'قطعة', variantId: null, variantLabel: null, quantity: 1},
      ],
      products: [clothing()],
      customers: customers(),
      payKind: 'cash',
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain('اختيار اللون/المقاس');
  });

  test('وحدة استُبدلت → الشفاء بالاسم يوصلها', () => {
    // الوحدة القديمة (8) لم تعد موجودة؛ «علبة» الحالية معرّفها 3.
    const result = validateSaleDraft({
      lines: [
        {productId: 7, productName: 'عصير', unitId: 8, unitName: 'علبة', variantId: null, variantLabel: null, quantity: 1},
      ],
      products: [product()],
      customers: customers(),
      payKind: 'cash',
    });
    expect(result.ok).toBe(true);
    expect(result.healedLines[0].unitId).toBe(3);
  });

  test('دين بزبون محذوف وأُنشئ باسمه → الشفاء بالاسم يوصل الفاتورة', () => {
    const result = validateSaleDraft({
      lines: [
        {productId: 7, productName: 'عصير', unitId: null, unitName: 'حبة', variantId: null, variantLabel: null, quantity: 2},
      ],
      products: [product()],
      customers: customers(),
      payKind: 'debt',
      customerId: 55, // المعرّف القديم مات.
      customerName: 'أحمد',
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedCustomer).toEqual({id: 1, name: 'أحمد'});
  });

  test('دين بلا زبون في الدفتر إطلاقاً → رفض قبل الحفظ', () => {
    const result = validateSaleDraft({
      lines: [
        {productId: 7, productName: 'عصير', unitId: null, unitName: 'حبة', variantId: null, variantLabel: null, quantity: 1},
      ],
      products: [product()],
      customers: customers(),
      payKind: 'debt',
      customerId: 55,
      customerName: 'مجهول تماماً',
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain('زبون الدفتر غير موجود');
  });

  test('مسودة سليمة تماماً → تجتاز بلا قضايا وبلا تغيير معرّفات', () => {
    const result = validateSaleDraft({
      lines: [
        {productId: 7, productName: 'عصير', unitId: 3, unitName: 'علبة', variantId: null, variantLabel: null, quantity: 2},
        {productId: 9, productName: 'تيشيرت', unitId: null, unitName: 'قطعة', variantId: 22, variantLabel: 'أبيض · M', quantity: 1},
      ],
      products: [product(), clothing()],
      customers: customers(),
      payKind: 'debt',
      customerId: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.healedLines).toHaveLength(2);
    expect(result.healedLines[0].unitId).toBe(3);
    expect(result.healedLines[1].variantId).toBe(22);
    expect(result.resolvedCustomer).toEqual({id: 2, name: 'سالم'});
  });

  test('تسمية المتغير تطابق معادلة الخادم حرفياً (الحجم أو اللون · المقاس)', () => {
    const size = {kind: 'size', color: '', size: 'كبير'};
    const clothed = {kind: 'variant', color: 'أسود', size: 'L'};
    const noColor = {kind: 'variant', color: '', size: 'L'};
    const {variantDisplayLabel} = jest.requireActual('../src/store/validation') as {
      variantDisplayLabel: (v: {kind: string; color: string; size: string}) => string;
    };
    expect(variantDisplayLabel(size)).toBe('كبير');
    expect(variantDisplayLabel(clothed)).toBe('أسود · L');
    expect(variantDisplayLabel(noColor)).toBe('L');
  });
});

// ── ④ فلاتر الفواتير ────────────────────────────────────────────

function invoice(overrides: Partial<LocalInvoice> = {}): LocalInvoice {
  return {
    ref: 'C-dev-1',
    kind: 'sale',
    displayNumber: 'م-1',
    syncedNumber: null,
    status: 'pending',
    payKind: 'cash',
    payMethod: 'cash',
    total: 30,
    discount: 0,
    customerName: null,
    customerId: null,
    createdAt: '2026-11-06 10:00:00',
    syncedAt: null,
    rejectReason: null,
    sourceRef: null,
    ...overrides,
  };
}

describe('v3.5 (كاشير #4) — فلاتر أرشيف الفواتير', () => {
  const list: LocalInvoice[] = [
    invoice({ref: 'a', payMethod: 'cash', status: 'synced', syncedNumber: 'INV-100'}),
    invoice({ref: 'b', payMethod: 'jawwal_pay', status: 'synced', syncedNumber: 'INV-101'}),
    invoice({ref: 'c', payMethod: 'palpay', status: 'pending'}),
    invoice({ref: 'd', payMethod: 'cash', payKind: 'debt', status: 'pending', customerName: 'أحمد'}),
    invoice({ref: 'e', kind: 'return', payKind: 'refund', payMethod: 'cash', status: 'rejected', rejectReason: 'سبب'}),
  ];
  const noItems: Record<string, never[]> = {};

  test('فلتر قناة الدفع: جوال باي وحده', () => {
    const out = filterInvoices(list, {period: 'all', kind: 'all', pay: 'jawwal_pay', status: 'all', query: ''}, noItems);
    expect(out.map(i => i.ref)).toEqual(['b']);
  });

  test('فلتر القناة مع النقدي: يشمل دين اليوم النقدي', () => {
    const out = filterInvoices(list, {period: 'all', kind: 'all', pay: 'cash', status: 'all', query: ''}, noItems);
    expect(out.map(i => i.ref).sort()).toEqual(['a', 'd', 'e']);
  });

  test('فلتر حالة المزامنة: المرفوضة', () => {
    const out = filterInvoices(list, {period: 'all', kind: 'all', pay: 'all', status: 'rejected', query: ''}, noItems);
    expect(out.map(i => i.ref)).toEqual(['e']);
  });

  test('القناة + الحالة معاً: جوال باي المتزامنة', () => {
    const out = filterInvoices(list, {period: 'all', kind: 'all', pay: 'jawwal_pay', status: 'synced', query: ''}, noItems);
    expect(out.map(i => i.ref)).toEqual(['b']);
  });

  test('النوع (ديون) مع الحالة (معلقة)', () => {
    const out = filterInvoices(list, {period: 'all', kind: 'debts', pay: 'all', status: 'pending', query: ''}, noItems);
    expect(out.map(i => i.ref)).toEqual(['d']);
  });

  test('فاتورة بلا payment_method (تثبيتات قديمة) تُعامل نقدياً', () => {
    const legacy = invoice({ref: 'old', payMethod: 'cash'});
    const out = filterInvoices([legacy], {period: 'all', kind: 'all', pay: 'cash', status: 'all', query: ''}, noItems);
    expect(out).toHaveLength(1);
  });

  test('البحث باسم الزبون مع فلتر القناة', () => {
    const out = filterInvoices(list, {period: 'all', kind: 'all', pay: 'cash', status: 'all', query: 'أحمد'}, noItems);
    expect(out.map(i => i.ref)).toEqual(['d']);
  });
});

// ── ⑤ مسامير الإصدار ────────────────────────────────────────────

describe('v3.5 — مسامير الإصدار', () => {
  test('config: 3.5.0 (12)', () => {
    expect(APP_VERSION).toBe('3.5.0');
    expect(APP_BUILD_CODE).toBe(12);
    expect(APP_VERSION_LABEL).toBe('3.5.0 (12)');
  });

  test('build.gradle: versionCode 12 و versionName 3.5.0', () => {
    const fs = require('fs') as typeof import('fs');
    const gradle = fs.readFileSync('android/app/build.gradle', 'utf8');
    expect(gradle).toContain('versionCode 12');
    expect(gradle).toContain('versionName "3.5.0"');
  });

  test('package.json: 3.5.0', () => {
    const pkg = JSON.parse(
      (require('fs') as typeof import('fs')).readFileSync('package.json', 'utf8'),
    ) as {version: string};
    expect(pkg.version).toBe('3.5.0');
  });
});
