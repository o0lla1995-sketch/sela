/**
 * store/validation.ts — v3.5 (الجولة 91 — كاشير #3): التحقق من
 * سلامة الفاتورة قبل الحفظ المحلي.
 * ─────────────────────────────────────────────────────────────────
 * الشكوى الجذرية: «فواتير مرفوضة عند المزامنة (مثال: منتج
 * بمتغيرات) — لا يوجد تحقق من سلامة الفاتورة قبل الحفظ وانتظار
 * المزامنة». كانت الفاتورة تُحفظ محلياً أياً كان محتواها ثم
 * تُرفض نهائياً عند المزامنة (حُذف المنتج، أُعيد إنشاء المتغيرات
 * بتحرير المنتج فتغيّرت معرّفاتها، حُذف زبون الدفتر…) — والبضاعة
 * خرجت من المتجر فعلاً والكاشير يكتشف الرفض متأخراً.
 *
 * المنهج ثلاث طبقات:
 *  ① تحقق قبل الحفظ المحلي (هذا الملف): كل سطر يُفحص ضد الكتالوج
 *     المؤقت وزبائن الدفتر — منتج موجود، متغير موجود (أو قابل
 *     للشفاء بالتسمية)، وحدة موجودة، زبون الدفع بالدين موجود.
 *     فشل التحقق = لا حفظ أصلاً ورسالة عربية واضحة الآن لا رفضاً
 *     غامضاً بعد ساعات.
 *  ② شفاء محلي قبل الحفظ: معرّف متغير انتهك (أُعيد إنشاؤه في
 *     نقطة البيع بعد آخر مزامنة) تُوصَل تسميته («أسود · L» أو
 *     الحجم) بالمتغير الحالي من نفس القواعد التي يطبقها الخادم
 *     (v78.1) — فتُحفظ الفاتورة سليمة من الأساس.
 *  ③ الشفاء على الخادم (v78.1 أندرويد) يبقى شبكة الأمان عند
 *     تغيّر الكتالوج بعد الحفظ المحلي وقبل المزامنة.
 */
import type {CatalogProduct, LocalCustomer} from '../api/types';

/** سطر مسودة كما يبنيه التحقق — مستقل عن واجهة السلة كي يُختبر
 *  بحتاً، والواجهة تحوّل أسطرها إليه. */
export interface DraftSaleLine {
  productId: number;
  productName: string;
  unitId: number | null;
  unitName: string | null;
  variantId: number | null;
  variantLabel: string | null;
  quantity: number;
}

export interface DraftValidationOptions {
  lines: DraftSaleLine[];
  products: CatalogProduct[];
  /** زبائن دفتر المتجر (من الخادم أو النسخة المخزنة). */
  customers: LocalCustomer[];
  /** cash | debt — الدين يفرض وجود زبون. */
  payKind: 'cash' | 'debt';
  /** معرّف زبون الدفتر للبيع بالدين. */
  customerId?: number | null;
  /** اسم زبون الدفتر (للشفاء بالاسم عند تغيّر المعرّف). */
  customerName?: string | null;
}

export interface DraftValidationResult {
  ok: boolean;
  /** رسائل عربية واضحة لما يمنع الحفظ (فارغة عند السلامة). */
  issues: string[];
  /** الأسطر بعد الشفاء المحلي (معرّفات متغيرات موصولة بالحالي). */
  healedLines: DraftSaleLine[];
  /** الزبون الموصول بعد الشفاء بالاسم (إن كان بالدين). */
  resolvedCustomer: {id: number; name: string} | null;
}

/** تسمية متغير بنفس معادلة الخادم (LanHandlers v78.1) حرفياً —
 *  الحجم يعرض size، والملابس «اللون · المقاس». */
export function variantDisplayLabel(variant: {
  kind: string;
  color: string;
  size: string;
}): string {
  const isSize = variant.kind === 'size';
  return isSize
    ? variant.size
    : variant.color
    ? `${variant.color} · ${variant.size}`
    : variant.size;
}

/**
 * التحقق الكامل + الشفاء المحلي. دالة خالصة (بلا آثار جانبية)
 * قابلة للاختبار — تُستدعى قبل أي حفظ محلي (المسار دون اتصال)
 * وقبل محاولة الإرسال المباشر لتقطع الباطل مبكراً برسالة أوضح.
 */
export function validateSaleDraft(
  options: DraftValidationOptions,
): DraftValidationResult {
  const issues: string[] = [];
  const healedLines: DraftSaleLine[] = [];
  const byId = new Map(options.products.map(p => [p.id, p]));

  for (const line of options.lines) {
    const product = byId.get(line.productId);
    if (product == null) {
      issues.push(
        `«${line.productName || `منتج #${line.productId}`}» لم يعد في المخزون — حُذف من نقطة البيع؟ احذف السطر`,
      );
      continue;
    }
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      issues.push(`كمية غير صالحة لـ «${product.name}»`);
      continue;
    }

    let variantId = line.variantId;
    // منتج متغيرات بلا متغير مختار — الخادم يرفضه دائماً.
    if (product.hasVariants && variantId == null) {
      issues.push(
        `«${product.name}» يحتاج اختيار اللون/المقاس (أو الحجم) أولاً`,
      );
      continue;
    }
    if (!product.hasVariants && variantId != null) {
      issues.push(`«${product.name}» ليس منتج متغيرات — احذف اختيار المتغير`);
      continue;
    }
    // ② الشفاء المحلي: المعرّف انتهك والتسمية تحلّه (نفس قاعدة
    // الخادم v78.1 حرفياً).
    if (
      variantId != null &&
      !product.variants.some(v => v.id === variantId) &&
      line.variantLabel != null &&
      line.variantLabel.length > 0
    ) {
      const wanted = line.variantLabel.trim();
      const healed = product.variants.find(
        v => variantDisplayLabel(v) === wanted,
      );
      if (healed != null) {
        variantId = healed.id;
      }
    }
    if (variantId != null && !product.variants.some(v => v.id === variantId)) {
      issues.push(
        line.variantLabel != null && line.variantLabel.length > 0
          ? `متغير «${line.variantLabel}» غير متاح لـ «${product.name}» — أعِد اختياره`
          : `متغير غير متاح لـ «${product.name}» — أعِد اختياره`,
      );
      continue;
    }

    let unitId = line.unitId;
    if (unitId != null && !product.units.some(u => u.id === unitId)) {
      // الوحدة انتهكت (أُعيد إنشاؤها بتحرير المنتج) — نحاول شفاءها
      // بالاسم ثم بمشتق التحويل؛ وإلا فالسطر مكسور.
      const wantedName = (line.unitName ?? '').trim();
      const healed =
        product.units.find(u => u.name === wantedName) ??
        product.units.find(
          u =>
            wantedName.length > 0 &&
            (u.short === wantedName || u.name.includes(wantedName)),
        );
      if (healed != null) {
        unitId = healed.id;
      } else {
        issues.push(
          `وحدة البيع «${line.unitName ?? unitId}» غير متاحة لـ «${product.name}» — أعِد اختيارها`,
        );
        continue;
      }
    }

    healedLines.push({...line, variantId, unitId});
  }

  // الدين: زبون الدفتر موجود (بالمعرّف، أو شفاءً بالاسم — نفس
  // قاعدة الخادم v78.1).
  let resolvedCustomer: {id: number; name: string} | null = null;
  if (options.payKind === 'debt') {
    const byCustomerId = options.customers.find(
      c => c.id === Number(options.customerId ?? 0),
    );
    let found = byCustomerId ?? null;
    if (found == null && options.customerName != null) {
      const wanted = options.customerName.trim();
      if (wanted.length > 0) {
        found = options.customers.find(c => c.name === wanted) ?? null;
      }
    }
    if (found == null) {
      issues.push(
        'زبون الدفتر غير موجود — حُذف من نقطة البيع؟ اختر زبوناً آخر (البيع بالدين يتطلب زبوناً من الدفتر)',
      );
    } else {
      resolvedCustomer = {id: found.id, name: found.name};
    }
  }

  return {ok: issues.length === 0, issues, healedLines, resolvedCustomer};
}
