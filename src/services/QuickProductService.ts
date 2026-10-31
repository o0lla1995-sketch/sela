/**
 * QuickProductService — v58 (الجولة 62): منطق الإضافة السريعة لمود
 * «نقطة البيع» (مستخرج من نافذة الواجهة ليُختبر ويُشارك مع سطح
 * المكتب).
 * ─────────────────────────────────────────────────────────────────
 * يبني المنتج ووحداته بالمنظومة القائمة نفسها (ProductRepo +
 * UnitRepo.replaceForProduct) بلا أي مسارات جديدة:
 *
 *  • piece/box: منتج قطعي أساسه الحبة (retail = سعر الحبة) بوحدتي
 *    «حبة» (=1) و«علبة» (= عدد الحبات) بأسعار كل منهما.
 *  • gram: منتج وزني (سعر الكيلو = سعر الغرام × 1000) بوحدة «غرام»
 *    (=0.001 كغ) — لوحة الوزن تعرضها شريحة سريعة.
 *  • المخزون الفارغ → بلا تتبع (البيع لا يُحجب)؛ وإلا يُحوَّل
 *    لوحدة الأساس (علبة × عدد الحبات / غرام ÷ 1000).
 */
import {ProductRepo} from '../database/repositories/ProductRepo';
import {UnitRepo} from '../database/repositories/UnitRepo';
import {CategoryRepo} from '../database/repositories/CategoryRepo';
import {useSettingsStore} from '../stores/settingsStore';

export type QuickSellBy = 'piece' | 'box' | 'gram';

/** v70 (الجولة 82 #٤): وحدة بيع إضافية بسعر مميّز — طلب التاجر:
 *  «لماذا في المنتج السريع لا يوجد إضافة وحدات للمنتج مثلاً
 *  للبيع بأكثر من قطعة بسعر مميّز». الكرطونة/الصينية/الكيس… كل
 *  واحدة بعدد حباتها (أو وزنها بالكيلو للمنتجات الوزنية) وبسعرها
 *  الخاص — تسير في منتقي الوحدة نفسه في سطر السلة. */
export interface QuickExtraUnit {
  name: string;
  /** القطعي: عدد الحبات في الوحدة (كرتونة = 200). الوزني: الوزن
   *  بالكيلوغرام (ربع كيلو = 0.25). */
  perBase: number;
  /** سعر بيع هذه الوحدة — المميّز هو جوهر الطلب. */
  price: number;
}

export interface QuickProductInput {
  name: string;
  sellBy: QuickSellBy;
  /** سعر الوحدة المختارة: الحبة (piece) أو العلبة (box) أو الغرام (gram). */
  price: number;
  /** عدد الحبات في العلبة (للقطعي) — افتراضياً 20. */
  perBox?: number;
  /** سعر العلبة الصريح (piece) — إن غاب يُشتق: سعر الحبة × العدد. */
  boxPriceOverride?: number | null;
  /** المخزون الابتدائي بوحدة الإدخال (علبة للقطعي / غرام للوزني). */
  stockInput?: number | null;
  barcode?: string | null;
  /** v70: وحدات إضافية بأسعار خاصة (اختياري). */
  extraUnits?: QuickExtraUnit[];
}

export interface QuickProductResult {
  productId: number;
  /** وحدات البيع التي وُضعت للمنتج. */
  unitCount: number;
  /** المخزون المخزَّن بوحدة الأساس (حبات / كغ). */
  stockBase: number;
  untracked: boolean;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export const QuickProductService = {
  async createQuickProduct(
    input: QuickProductInput,
  ): Promise<QuickProductResult> {
    const name = input.name.trim();
    if (!name) {
      throw new Error('اسم المنتج مطلوب');
    }
    const price = Number(input.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error('السعر غير صالح');
    }
    const perBox = Math.round(Number(input.perBox ?? 20));
    const isWeight = input.sellBy === 'gram';

    // التصنيف الافتراضي لأصناف هذا المود (أول تصنيف موسوم به).
    const storeMode = useSettingsStore.getState().settings.storeMode;
    const categories = await CategoryRepo.list(storeMode);
    const categoryId = categories.length > 0 ? categories[0].id : null;

    let piecePrice: number;
    let boxPrice: number | null = null;
    if (input.sellBy === 'piece') {
      piecePrice = round2(price);
      boxPrice =
        input.boxPriceOverride != null
          ? round2(Number(input.boxPriceOverride))
          : perBox >= 2
          ? round2(price * perBox)
          : null;
    } else if (input.sellBy === 'box') {
      if (perBox < 2) {
        throw new Error('عدد الحبات في العلبة غير صالح');
      }
      boxPrice = round2(price);
      piecePrice = round2(price / perBox);
    } else {
      piecePrice = round2(price); // سعر الوحدة الصغرى = الغرام
    }

    const stockInput =
      input.stockInput != null && Number.isFinite(Number(input.stockInput))
        ? Number(input.stockInput)
        : null;

    // المخزون بوحدة الأساس: قطعي → حبات، وزني → كغ.
    const stockBase =
      stockInput == null
        ? 0
        : isWeight
        ? Math.round(stockInput / 1000 * 1000000) / 1000000
        : input.sellBy === 'box' || perBox >= 2
        ? Math.round(stockInput * perBox * 1000) / 1000
        : stockInput;

    const productId = await ProductRepo.create({
      name,
      cost_price: 0,
      retail_price: isWeight ? round2(piecePrice * 1000) : piecePrice,
      wholesale_price: 0,
      stock_quantity: stockBase,
      category_id: categoryId,
      image_uri: null,
      barcode: input.barcode?.trim() || null,
      sold_by_weight: isWeight ? 1 : 0,
      base_unit_name: isWeight ? 'كغ' : 'حبة',
      stock_untracked: stockInput == null ? 1 : 0,
    });

    let unitCount = 0;
    if (isWeight) {
      const gramUnit = await UnitRepo.getOrCreate('غرام', 'غ', 'weight', storeMode);
      await UnitRepo.replaceForProduct(productId, [
        {
          unit_id: gramUnit,
          conversion: 0.001,
          retail_price: piecePrice,
          wholesale_price: null,
        },
      ]);
      unitCount = 1;
    } else {
      const pieceUnit = await UnitRepo.getOrCreate('حبة', 'حبة', 'piece', storeMode);
      const rows: Parameters<typeof UnitRepo.replaceForProduct>[1] = [
        {
          unit_id: pieceUnit,
          conversion: 1,
          retail_price: piecePrice,
          wholesale_price: null,
        },
      ];
      if (boxPrice != null && perBox >= 2) {
        const boxUnit = await UnitRepo.getOrCreate('علبة', 'علبة', 'piece', storeMode);
        rows.push({
          unit_id: boxUnit,
          conversion: perBox,
          retail_price: boxPrice,
          wholesale_price: null,
        });
      }
      await UnitRepo.replaceForProduct(productId, rows);
      unitCount = rows.length;
    }

    // ── v70 (الجولة 82 #٤): الوحدات الإضافية بسعر مميّز ──
    // تُدمج في نفس استدعاء replaceForProduct للمنتج (صورة واحدة
    // نظيفة)، بعد التحقق: اسم غير فارغ ومختلف عن الوحدات الأساسية
    // ومكرر، معامل > 0، وسعر > 0. القطعي: المعامل بالحبات؛ الوزني:
    // بالكيلوغرام (كسور مسموحة — وقية = 0.25).
    const extras = (input.extraUnits ?? []).filter(
      unit => unit.name.trim().length > 0,
    );
    if (extras.length > 0) {
      const baseNames = new Set(
        ['حبة', 'علبة', 'غرام'].map(n => n.replace(/[أإآ]/g, 'ا').trim()),
      );
      const seen = new Set<string>();
      const baseRows = isWeight
        ? [
            {
              unit_id: await UnitRepo.getOrCreate(
                'غرام',
                'غ',
                'weight',
                storeMode,
              ),
              conversion: 0.001,
              retail_price: piecePrice,
              wholesale_price: null,
            },
          ]
        : [
            {
              unit_id: await UnitRepo.getOrCreate(
                'حبة',
                'حبة',
                'piece',
                storeMode,
              ),
              conversion: 1,
              retail_price: piecePrice,
              wholesale_price: null,
            },
          ];
      if (!isWeight && boxPrice != null && perBox >= 2) {
        baseRows.push({
          unit_id: await UnitRepo.getOrCreate('علبة', 'علبة', 'piece', storeMode),
          conversion: perBox,
          retail_price: boxPrice,
          wholesale_price: null,
        });
      }
      const extraRows: typeof baseRows = [];
      for (const unit of extras) {
        const name = unit.name.trim();
        const normalized = name.replace(/[أإآ]/g, 'ا').trim();
        if (baseNames.has(normalized) || seen.has(normalized)) {
          throw new Error(
            `اسم الوحدة «${name}» مستخدم مسبقاً — اختر اسماً مختلفاً لكل وحدة`,
          );
        }
        const perBase = Number(unit.perBase);
        if (!Number.isFinite(perBase) || perBase <= 0) {
          throw new Error(
            `عدد الحبات في «${name}» غير صالح — أدخل رقماً أكبر من صفر`,
          );
        }
        const price = Number(unit.price);
        if (!Number.isFinite(price) || price <= 0) {
          throw new Error(`سعر «${name}» غير صالح — أدخل رقماً أكبر من صفر`);
        }
        seen.add(normalized);
        const unitId = await UnitRepo.getOrCreate(
          name,
          name,
          isWeight ? 'weight' : 'piece',
          storeMode,
        );
        extraRows.push({
          unit_id: unitId,
          conversion: isWeight ? perBase : Math.round(perBase * 1000) / 1000,
          retail_price: round2(price),
          wholesale_price: null,
        });
      }
      await UnitRepo.replaceForProduct(productId, [...baseRows, ...extraRows]);
      unitCount = baseRows.length + extraRows.length;
    }

    return {
      productId,
      unitCount,
      stockBase,
      untracked: stockInput == null,
    };
  },
};
