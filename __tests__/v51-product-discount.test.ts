/**
 * v51 — سلسلة الخصومات الكاملة (خصم المنتج → البيع → المول).
 * ─────────────────────────────────────────────────────────────────
 * حرّوس الجسر الكامل لخصم المنتج الذي يحدده التاجر:
 *
 * ① ترحيل v26: عمود products.discount_pct يُضاف لقاعدة قائمة.
 * ② المستودع: create/update يحفظان الخصم مقيداً 0–95 (نفس قيد
 *    الخادم) — القيم الشاذة تُقص ولا تُرفض.
 * ③ التسعير: unitPriceFor يطبّق الخصم على سعر المفرق والجملة
 *    وتجاوزات الوحدات معاً — السلة والفاتورة والتقارير تمر كلها
 *    من هنا فتتسق السلسلة بلا استثناء.
 * ④ التكلفة لا تتغير — هامش الربح في التقارير صادق بعد الخصم.
 * ⑤ المزامنة: discountPct تُرسل في حمولة كتالوج المول (خادم 4.5+).
 * ⑥ شبكة البيع تعرض السعر القديم مشطوباً + شارة النسبة.
 */
import {freshApp, tempDb} from './helpers/app';

const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;

describe('v51 — سلسلة الخصومات الكاملة', () => {
  test('① ترحيل v26: عمود discount_pct على قاعدة قائمة', async () => {
    const app = freshApp(':memory:');
    await app.connection.initDatabase();
    const db = app.connection.getDb();
    const res = db.execute(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('products') WHERE name = 'discount_pct'",
    );
    const rows = (res.rows ?? []) as unknown as {cnt?: number}[];
    expect(Number(rows[0]?.cnt ?? 0)).toBe(1);
    // القيمة الافتراضية 0 — لا خصم على أي منتج قائم.
    const sample = db.execute(
      'SELECT COALESCE(discount_pct, -1) AS d FROM products LIMIT 1',
    );
    const sampleRows = (sample.rows ?? []) as unknown as {d?: number}[];
    if (sampleRows.length > 0) {
      expect(Number(sampleRows[0].d)).toBe(0);
    }
  });

  test('② المستودع: الخصم يُحفظ مقيداً 0–95', async () => {
    const app = freshApp(':memory:');
    await app.connection.initDatabase();
    const ProductRepo = require('../src/database/repositories/ProductRepo')
      .ProductRepo as {
      create: (i: Record<string, unknown>) => Promise<number>;
      update: (id: number, i: Record<string, unknown>) => Promise<void>;
      getById: (id: number) => Promise<{
        discount_pct: number;
        retail_price: number;
      } | null>;
    };

    const id = await ProductRepo.create({
      name: 'أرز الخصم',
      cost_price: 5,
      retail_price: 10,
      wholesale_price: 8,
      stock_quantity: 100,
      category_id: null,
      image_uri: null,
      discount_pct: 20,
    });
    let product = await ProductRepo.getById(id);
    expect(product?.discount_pct).toBe(20);

    // تحديث لقيمة شاذة (120) → تُقص إلى 95.
    await ProductRepo.update(id, {
      name: 'أرز الخصم',
      cost_price: 5,
      retail_price: 10,
      wholesale_price: 8,
      stock_quantity: 100,
      category_id: null,
      image_uri: null,
      discount_pct: 120,
    });
    product = await ProductRepo.getById(id);
    expect(product?.discount_pct).toBe(95);

    // سالبة → 0 (بلا خصم).
    await ProductRepo.update(id, {
      name: 'أرز الخصم',
      cost_price: 5,
      retail_price: 10,
      wholesale_price: 8,
      stock_quantity: 100,
      category_id: null,
      image_uri: null,
      discount_pct: -5,
    });
    product = await ProductRepo.getById(id);
    expect(product?.discount_pct).toBe(0);
  });

  test('③ التسعير: الخصم على المفرق والجملة وتجاوزات الوحدات', async () => {
    freshApp(':memory:');
    const {unitPriceFor} = require('../src/stores/cartStore');

    const product = {
      id: 1,
      name: 'زيت',
      cost_price: 6,
      retail_price: 10,
      wholesale_price: 8,
      discount_pct: 20,
    };
    // المفرق: 10 → 8 بعد الخصم.
    expect(unitPriceFor(product, null, 'RETAIL')).toBe(8);
    // الجملة: 8 → 6.4.
    expect(unitPriceFor(product, null, 'WHOLESALE')).toBe(6.4);
    // تجاوز وحدة (كرتونة 12 قطعة بـ 120 مفرق): 120 → 96.
    const unit = {
      id: 1,
      product_id: 1,
      unit_id: 1,
      unitName: 'كرتونة',
      unitShort: 'كرت',
      conversion: 12,
      barcode: null,
      retail_price: 120,
      wholesale_price: null,
    };
    expect(unitPriceFor(product, unit, 'RETAIL')).toBe(96);
    // بلا خصم — السعر كما هو.
    expect(
      unitPriceFor({...product, discount_pct: 0}, null, 'RETAIL'),
    ).toBe(10);
  });

  test('④ التكلفة لا تتغير (هامش الربح صادق)', async () => {
    freshApp(':memory:');
    const cartStore = require('../src/stores/cartStore');
    // منتج بتكلفة 6 وسعر 10 وخصم 50%: الربح = 5 − 6 = −1 (خسارة
    // حقيقية تظهر في التقارير — لا تُطمس بتاتاً).
    const product = {
      id: 1,
      name: 'خاسر',
      cost_price: 6,
      retail_price: 10,
      wholesale_price: 8,
      discount_pct: 50,
    };
    const line = (cartStore as {toLine: Function}).toLine(product, 'RETAIL', null, 1);
    expect(line.unitPrice).toBe(5);
    expect(line.costPrice).toBe(6);
  });

  test('⑤ المزامنة: discountPct في حمولة كتالوج المول', () => {
    const service = read('src/services/online/OnlineStoreService.ts');
    expect(service).toContain('discountPct:');
    // القيد نفسه (0–95) مطابق للخادم.
    expect(service).toContain('Math.min(95');
  });

  test('⑥ شبكة البيع: السعر القديم مشطوب + شارة النسبة', () => {
    const pos = read('src/screens/PosScreen.tsx');
    expect(pos).toContain('applyProductDiscount');
    expect(pos).toContain('textDecorationLine');
    expect(pos).toContain('oldPriceLabel');
    // نموذج المنتج: حقل الخصم + معاينة حية للسعر النهائي.
    const form = read('src/screens/inventory/ProductFormScreen.tsx');
    expect(form).toContain('خصم المنتج (%)');
    expect(form).toContain('بعد الخصم:');
  });
});
