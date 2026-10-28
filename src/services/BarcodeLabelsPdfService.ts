/**
 * services/BarcodeLabelsPdfService.ts — v65 (الجولة 77 — أندرويد #٢ب):
 * تصدير ملصقات الباركود كملف PDF من الهاتف.
 * ─────────────────────────────────────────────────────────────────
 * طلب التاجر: «في إضافة منتج في تطبيق نقطة البيع أندرويد لم تقم
 * بإضافة المميزات التي قمت بتطويرها عند اضافة منتج في سطح المكتب
 * مثل … طباعة الباركودات المولدة بملف pdf كخيار».
 *
 * نفس تصميم سطح المكتب (BarcodePdfService v70) حرفياً — الرسم نفسه
 * في Kotlin أصلي (PdfDocument + Tajawal): ملصقات مربعة 40/50/60مم
 * على صفحات مربعة أو ورق A4، إطار قص متقطع وعلامات زوايا، اسم
 * المنتج بأول سطرين، أعمدة الباركود من نمط الوحدات المحسوب هنا في
 * JS (encodeBarcodeBars — EAN-13 أو CODE128)، والسعر اختيارياً.
 * بعدها يشارك الملف أو يُطبع بأي طابعة عبر إطار الطباعة النظامي.
 */
import {encodeBarcodeBars} from './BarcodeService';
import {formatMoney} from '../core/format';
import {requirePlatformUtils} from '../native/nativeBridge';

export interface BarcodeLabelEntry {
  name: string;
  barcode: string;
  /** السعر المعروض تحت الباركود (null = إخفاء السعر). */
  price?: number | null;
  copies: number;
}

export interface LabelSheetOptions {
  /** ضلع الملصق المربع بالمليمتر — 40/50/60. */
  labelMm: 40 | 50 | 60;
  /** صفحة مربعة (افتراضي) أو A4 لورق الطابعات. */
  pageKind: 'square' | 'a4';
  /** طباعة السعر على الملصق. */
  showPrice: boolean;
}

export const DEFAULT_LABEL_OPTIONS: LabelSheetOptions = {
  labelMm: 50,
  pageKind: 'square',
  showPrice: true,
};

/**
 * توليد ملف PDF وحفظه في مجلد التنزيلات — يعيد اسم الملف
 * (للمشاركة/الطباعة لاحقاً) ومساره المقروء. يرمي رسالة عربية
 * واضحة عند أي خلل.
 */
export async function exportBarcodeLabelsPdf(
  entries: BarcodeLabelEntry[],
  options: LabelSheetOptions,
): Promise<{fileName: string; location: string}> {
  const clean = entries.filter(e => e.barcode.trim().length > 0);
  if (clean.length === 0) {
    throw new Error('لا توجد ملصقات للتصدير — أدخل باركود أولاً');
  }
  const payload = {
    labelMm: options.labelMm,
    pageKind: options.pageKind,
    showPrice: options.showPrice,
    entries: clean.map(entry => ({
      name: entry.name,
      barcode: entry.barcode.trim(),
      price:
        options.showPrice && entry.price != null && Number.isFinite(entry.price)
          ? formatMoney(entry.price)
          : '',
      copies: Math.max(1, Math.min(500, Math.round(entry.copies) || 1)),
      // نمط أعمدة الباركود يُحسب هنا (JS) ويرسم في Kotlin.
      bits: encodeBarcodeBars(entry.barcode.trim())?.bits ?? '',
    })),
  };
  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `sela-barcodes-${stamp}.pdf`;
  const location = await requirePlatformUtils().createBarcodeLabelsPdf(
    fileName,
    JSON.stringify(payload),
  );
  return {fileName, location};
}
