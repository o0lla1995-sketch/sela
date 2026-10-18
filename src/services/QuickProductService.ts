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

    return {
      productId,
      unitCount,
      stockBase,
      untracked: stockInput == null,
    };
  },
};
