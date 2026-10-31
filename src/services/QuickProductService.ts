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
 *
 * v71 (الجولة 83 #٢): خيارات بيع بالعدد (باكجات) — طلب التاجر نصاً:
 * «نفس المنتج يباع بالقطعة الواحدة مثلاً بشيكل واحد ولكن مع خيارات
 * أخرى تظهر عند اختيار المنتج في البيع قبل إضافته للسلة — مثلاً
 * 3 حبات بـ2 شيكل أو 5 حبات بـ3 شيكل، مثل منتجات المطاعم
 * والكافيهات ولكن ليس أحجاماً بل عدداً، ويميزها في الفاتورة».
 * كل باكج يُبنى متغيرَ حجمٍ (kind='size') على المنظومة القائمة
 * نفسها — نافذة البيع تفتح تلقائياً لمنتجات الأحجام فتعرض:
 * «حبة» بسعرها المفرد + كل باكج بعدده وسعره المميز، والفاتورة
 * تطبع وصف الباكج بعد الاسم (مارلبورو (3 حبات)) — تماماً كأحجام
 * المطاعم لكن بالعدد. مخزون الباكج من مخزون المنتج نفسه (القطع
 * المحسوبة = عدده × كميته).
 */
import {ProductRepo} from '../database/repositories/ProductRepo';
import {UnitRepo} from '../database/repositories/UnitRepo';
import {CategoryRepo} from '../database/repositories/CategoryRepo';
import {VariantRepo} from '../database/repositories/VariantRepo';
import {useSettingsStore} from '../stores/settingsStore';

export type QuickSellBy = 'piece' | 'box' | 'gram';

/** v71 (الجولة 83 #٢): باكج بيع بالعدد — N حبة بسعر مميز. */
export interface QuickPackage {
  /** عدد الحبات في الباكج — صحيح ≥ 2. */
  count: number;
  /** سعر بيع الباكج كاملاً — المميّز هو جوهر الطلب. */
  price: number;
}

/** v71: تسمية الباكج كما تظهر في نافذة البيع والفاتورة. */
export function quickPackageLabel(count: number): string {
  const safe = Math.max(2, Math.round(count));
  return `${safe} ${safe >= 3 && safe <= 10 ? 'حبات' : 'حبة'}`;
}

/**
 * v71: استخراج عدد الباكج من تسمية متغير الحجم — «3 حبات» → 3.
 * يعود null لأي تسمية لا تطابق نمط باكجاتنا (أحجام المطاعم
 * «كبير/صغير» وهكذا) — فلا يتأثر مسار الأحجام الأصلي إطلاقاً.
 */
export function parsePackageCount(sizeLabel: string): number | null {
  const match = /^(\d+)\s+حبات?$/.exec(sizeLabel.trim());
  if (match == null) {
    return null;
  }
  const count = Number(match[1]);
  return Number.isInteger(count) && count >= 2 ? count : null;
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
  /** v71: خيارات بيع بالعدد (باكجات بسعر مميز) — للقطعي فقط. */
  packages?: QuickPackage[];
}

export interface QuickProductResult {
  productId: number;
  /** وحدات البيع التي وُضعت للمنتج. */
  unitCount: number;
  /** v71: خيارات البيع بالعدد المبنية (بما فيها خيار الحبة المفردة). */
  packageCount: number;
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

    // v71: تحقق الباكجات — عدداً صحيحاً ≥ 2 بلا تكرار وبسعر موجب.
    const packages: QuickPackage[] = [];
    if ((input.packages ?? []).length > 0) {
      if (isWeight) {
        throw new Error(
          'خيارات بيع العدد متاحة للمنتجات القطعية فقط — الوزني يُباع بالوزن من لوحة الوزن',
        );
      }
      const seenCounts = new Set<number>();
      for (const pack of input.packages ?? []) {
        const count = Math.round(Number(pack.count));
        if (!Number.isFinite(count) || count < 2) {
          throw new Error('عدد الحبات في خيار البيع يجب أن يكون رقماً 2 أو أكثر');
        }
        if (seenCounts.has(count)) {
          throw new Error(`خيار «${count} حبة» مكرر — لكل عددٍ خيار واحد`);
        }
        const packPrice = Number(pack.price);
        if (!Number.isFinite(packPrice) || packPrice <= 0) {
          throw new Error(`سعر خيار «${count} حبة» غير صالح — أدخل رقماً أكبر من صفر`);
        }
        seenCounts.add(count);
        packages.push({count, price: round2(packPrice)});
      }
      packages.sort((a, b) => a.count - b.count);
    }

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

    // ── v71 (الجولة 83 #٢): خيارات بيع بالعدد (باكجات) ──
    // تُبنى متغيرات أحجام (kind='size') على المنظومة القائمة:
    // خيار أول «حبة» بسعرها المفرد ثم كل باكج بعدده وسعره —
    // نافذة البيع تعرضها فور لمس المنتج، والفاتورة تميز الباكج
    // المختار بوصفه بعد الاسم. مخزون الأحجام نفسه يبقى صفراً
    // (المخزون على مستوى المنتج — sync=false كأحجام المطاعم).
    if (packages.length > 0) {
      await VariantRepo.replaceForProduct(
        productId,
        [
          {
            kind: 'size',
            color: '',
            size: 'حبة',
            stock_quantity: 0,
            retail_price: piecePrice,
            cost_price: null,
          },
          ...packages.map(pack => ({
            kind: 'size' as const,
            color: '',
            size: quickPackageLabel(pack.count),
            stock_quantity: 0,
            retail_price: pack.price,
            cost_price: null,
          })),
        ],
        false,
      );
    }

    return {
      productId,
      unitCount,
      packageCount: packages.length > 0 ? packages.length + 1 : 0,
      stockBase,
      untracked: stockInput == null,
    };
  },
};
