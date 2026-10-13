/**
 * v54 — الجولة 59: اكتمال سلسلة خصم المنتج في كل مسارات البيع.
 * ─────────────────────────────────────────────────────────────────
 * شكوى التاجر: «الخصم لا يحفظ بالمنتج ولا ينفذ في تطبيق نقطة
 * البيع». التشخيص: الحفظ سليم — الفجوة كانت في مسارات البيع:
 *
 * ① سطر متغير الملابس (لون × مقاس) كان يُسعَّر بالسعر الكامل.
 * ② سطر ربطة الجملة (قطعة من كل مقاس) كان بلا خصم.
 * ③ سطر حجم المطعم/الكافيتريا كان بلا خصم.
 * ④ تبديل مفرق/جملة كان يسقط الخصم كلياً (إعادة تسعير من
 *    لقطات ما قبل الخصم).
 * ⑤ نافذة البيع وورقة الوزن كانتا تعرضان السعر الكامل بينما
 *    السلة تُحسب بالمخفّض.
 *
 * كل سطر يحمل الآن discountPct (لحظة الإضافة) ويُعاد تطبيقه
 * عند أي إعادة تسعير — بلا خصم مزدوج أبداً.
 */
import {freshApp} from './helpers/app';

const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;

/** منتج ملابس بموديل لون × مقاس وخصم 20%. */
const clothingProduct = {
  id: 7,
  name: 'تيشيرت',
  cost_price: 10,
  retail_price: 40,
  wholesale_price: 25,
  discount_pct: 20,
  stock_quantity: 100,
  category_id: null,
  image_uri: null,
  low_stock_threshold: null,
  barcode: null,
  sold_by_weight: 0,
  is_archived: 0,
  expiry_date: null,
  style_group: null,
  variant_size: null,
  variant_color: null,
  has_variants: 1,
  base_unit_name: 'قطعة',
  stock_untracked: 0,
  sizes_count: 3,
  created_at: '2026-10-13 00:00:00',
  variants: [
    {
      id: 101,
      product_id: 7,
      kind: 'variant',
      color: 'أسود',
      size: 'L',
      stock_quantity: 10,
      retail_price: null,
      cost_price: null,
      created_at: '',
    },
  ],
};

/** منتج أحجام مطعم بخصم 25%. */
const sizedProduct = {
  ...clothingProduct,
  id: 8,
  name: 'قهوة',
  retail_price: 10,
  wholesale_price: 8,
  discount_pct: 25,
  has_variants: 1,
  sizes_count: null,
  variants: [
    {
      id: 201,
      product_id: 8,
      kind: 'size',
      color: '',
      size: 'كبير',
      stock_quantity: 0,
      retail_price: 12,
      cost_price: 4,
      created_at: '',
    },
  ],
};

describe('v54 — خصم المنتج في كل مسارات البيع', () => {
  test('① سطر متغير الملابس يُسعَّر بعد الخصم', () => {
    freshApp(':memory:');
    const {useCartStore} = require('../src/stores/cartStore');
    const store = useCartStore.getState();
    const variant = (clothingProduct.variants ?? [])[0];
    const result = store.addVariantLine(
      clothingProduct as never,
      'RETAIL',
      variant as never,
      2,
    );
    expect(result.added).toBe(true);
    const line = useCartStore.getState().lines[0];
    // 40 − 20% = 32 للقطعة.
    expect(line.unitPrice).toBe(32);
    expect(line.discountPct).toBe(20);
    // المرجع يبقى قبل الخصم (للعرض المشطوب وإعادة التسعير).
    expect(line.retailPrice).toBe(40);
  });

  test('② ربطة الجملة تُسعَّر بعد الخصم بلا خصم مزدوج', () => {
    freshApp(':memory:');
    const {useCartStore} = require('../src/stores/cartStore');
    const store = useCartStore.getState();
    const result = store.addBundleLine(
      clothingProduct as never,
      'أسود',
      1,
    );
    expect(result.added).toBe(true);
    const line = useCartStore.getState().lines[0];
    // الربطة = 25 جملة × 3 مقاسات = 75 → بعد 20% = 60.
    expect(line.unitPrice).toBe(60);
    // المرجع قبل الخصم — كي لا يُخصم مرتين عند التبديل.
    expect(line.retailPrice).toBe(75);
    expect(line.wholesalePrice).toBe(75);
    expect(line.discountPct).toBe(20);
  });

  test('③ حجم المطعم يُسعَّر بعد الخصم', () => {
    freshApp(':memory:');
    const {useCartStore} = require('../src/stores/cartStore');
    const store = useCartStore.getState();
    const size = (sizedProduct.variants ?? [])[0];
    const result = store.addSizedLine(
      sizedProduct as never,
      size as never,
      1,
    );
    expect(result.added).toBe(true);
    const line = useCartStore.getState().lines[0];
    // سعر الحجم 12 − 25% = 9.
    expect(line.unitPrice).toBe(9);
    expect(line.retailPrice).toBe(12);
    expect(line.discountPct).toBe(25);
  });

  test('④ تبديل مفرق/جملة يحافظ على الخصم (ولا يخصم مرتين)', () => {
    freshApp(':memory:');
    const {useCartStore} = require('../src/stores/cartStore');
    const store = useCartStore.getState();

    // منتج عادي 10 مفرق / 8 جملة بخصم 50%.
    const product = {
      ...clothingProduct,
      id: 9,
      variants: [],
      has_variants: 0,
      retail_price: 10,
      wholesale_price: 8,
      discount_pct: 50,
    };
    expect(store.addProduct(product as never, 'RETAIL', null, 1).added).toBe(
      true,
    );
    // متغير الملابس 40 مفرق بخصم 20%.
    const variant = (clothingProduct.variants ?? [])[0];
    expect(
      store.addVariantLine(clothingProduct as never, 'RETAIL', variant as never, 1)
        .added,
    ).toBe(true);

    let lines = useCartStore.getState().lines;
    expect(lines[0].unitPrice).toBe(5); // 10 − 50%
    expect(lines[1].unitPrice).toBe(32); // 40 − 20%

    // تبديل إلى جملة ثم العودة إلى مفرق — الخصم باقٍ في الاتجاهين.
    useCartStore.getState().setPricingMode('WHOLESALE');
    lines = useCartStore.getState().lines;
    expect(lines[0].unitPrice).toBe(4); // 8 − 50%
    expect(lines[1].unitPrice).toBe(32); // المتغير ثابت السعر (40−20%)

    useCartStore.getState().setPricingMode('RETAIL');
    lines = useCartStore.getState().lines;
    expect(lines[0].unitPrice).toBe(5); // عاد 10 − 50% (لا خصم مزدوج)
    expect(lines[1].unitPrice).toBe(32);

    // الربطة: إضافة ثم تبديل — لا خصم مزدوج.
    useCartStore.getState().clear();
    const s2 = useCartStore.getState();
    expect(s2.addBundleLine(clothingProduct as never, 'أسود', 2).added).toBe(
      true,
    );
    useCartStore.getState().setPricingMode('WHOLESALE');
    useCartStore.getState().setPricingMode('RETAIL');
    const bundle = useCartStore.getState().lines[0];
    expect(bundle.unitPrice).toBe(60); // 75 − 20% (لم تُخصم مرتين)
  });

  test('⑤ سطر المنتج العادي يحمل discountPct للحفاظ على السلسلة', () => {
    freshApp(':memory:');
    const {useCartStore} = require('../src/stores/cartStore');
    const store = useCartStore.getState();
    const product = {
      ...clothingProduct,
      id: 10,
      variants: [],
      has_variants: 0,
    };
    expect(store.addProduct(product as never, 'RETAIL', null, 1).added).toBe(
      true,
    );
    const line = useCartStore.getState().lines[0];
    expect(line.unitPrice).toBe(32);
    expect(line.discountPct).toBe(20);
    // منتج بلا خصم: 0 (وليس undefined).
    store.clear();
    const noDisc = {...product, id: 11, discount_pct: 0};
    expect(store.addProduct(noDisc as never, 'RETAIL', null, 1).added).toBe(
      true,
    );
    expect(useCartStore.getState().lines[0].discountPct).toBe(0);
    expect(useCartStore.getState().lines[0].unitPrice).toBe(40);
  });

  test('⑥ الفاتورة تحفظ الأسعار المخفّضة فعلاً (السلسلة كاملة)', async () => {
    const app = freshApp(':memory:');
    await app.connection.initDatabase();
    const {ProductRepo} = require('../src/database/repositories/ProductRepo');
    const {SaleRepo} = require('../src/database/repositories/SaleRepo');
    const {useCartStore} = require('../src/stores/cartStore');

    const id = await ProductRepo.create({
      name: 'منتج مخفّض',
      cost_price: 5,
      retail_price: 100,
      wholesale_price: 80,
      stock_quantity: 50,
      category_id: null,
      image_uri: null,
      discount_pct: 10,
    } as never);
    const saved = await ProductRepo.getById(id);
    expect(saved?.discount_pct).toBe(10);

    // يُباع بعد الخصم: 100 − 10% = 90.
    const store = useCartStore.getState();
    store.addProduct(saved as never, 'RETAIL', null, 3);
    const line = useCartStore.getState().lines[0];
    expect(line.unitPrice).toBe(90);

    const sale = await SaleRepo.createSale({
      invoiceNumber: 'T-54-1',
      lines: [line],
      discount: 0,
      paymentType: 'RETAIL',
    } as never);
    expect(sale.sale.total_amount).toBe(270);
    expect(sale.items[0].unit_price).toBe(90);
    // التكلفة كما هي — الربح صادق.
    expect(sale.items[0].cost_price).toBe(5);
    expect(sale.sale.total_profit).toBe(255);
  });

  test('⑦ مسودات ما قبل v54 (بلا discountPct) لا تتغير أسعارها', () => {
    freshApp(':memory:');
    const {useCartStore} = require('../src/stores/cartStore');
    // محاكاة مسودة قديمة: سعر مخزَّن بلا نسبة خصم.
    const store = useCartStore.getState();
    useCartStore.setState({
      lines: [
        {
          key: '1:0:0',
          productId: 1,
          name: 'قديم',
          unitPrice: 30,
          costPrice: 10,
          retailPrice: 30,
          wholesalePrice: 25,
          quantity: 1,
          availableStock: 99,
          unitId: null,
          unitName: 'قطعة',
          conversion: 1,
        } as never,
      ],
    });
    useCartStore.getState().setPricingMode('WHOLESALE');
    useCartStore.getState().setPricingMode('RETAIL');
    const line = useCartStore.getState().lines[0];
    // بلا discountPct → السعر كما خُزِّن (25 جملة ثم 30 مفرق).
    expect(line.unitPrice).toBe(30);
  });

  test('⑧ واجهات البيع تعرض المخفّض: النافذة والوزن وسطر السلة', () => {
    const pos = read('src/screens/PosScreen.tsx');
    // نافذة البيع: القيم المخفّضة + المرجع الخام للعرض المشطوب.
    expect(pos).toContain('perPieceRetailFinal');
    expect(pos).toContain('rawBundlePrice');
    expect(pos).toContain('pickedSizePriceRaw');
    // ورقة الوزن: سعر الكيلو بعد الخصم + الأصلي للعرض.
    expect(pos).toContain('kiloPriceRaw');
    // سطر السلة: الأصلي مشطوب + شارة النسبة.
    expect(pos).toContain("Math.round(line.discountPct ?? 0)");
    // applyPctDiscount مستورد من المخزن.
    expect(pos).toContain('applyPctDiscount,');
    // قائمة المخزون تعرض الخصم المحفوظ على المنتج (مشطوب + نسبة)
    // — يرى التاجر أن الخصم محفوظ فعلاً قبل البيع.
    const inventory = read('src/screens/inventory/InventoryScreen.tsx');
    expect(inventory).toContain('(−{Math.round(product.discount_pct ?? 0)}%)');
  });

  test('⑨ setPricingMode يعيد التسعير عبر applyPctDiscount (حارس المصدر)', () => {
    const cart = read('src/stores/cartStore.ts');
    expect(cart).toContain('unitPrice: applyPctDiscount(');
    expect(cart).toContain('line.discountPct ?? 0');
    // لا تسعير خام بلا خصم في التبديل بعد الآن.
    expect(cart).not.toContain(
      'unitPrice: mode === \'WHOLESALE\' ? line.wholesalePrice : line.retailPrice,',
    );
  });
});
