/**
 * receiptPreview — v40 (الجولة 48 #4): معاينة شكل الفاتورة كصورة.
 * ─────────────────────────────────────────────────────────────────
 * يبني SAME بنية فاتورة البيع الحرارية (receipt.ts) كصفوف JSON —
 * الشعار، الترويسة، رقم الفاتورة والتاريخ، الأسطر (اسم عربي ثم
 * سطر الكمية×السعر)، المجموع والخصم والإجمالي، الربح عند تفعيله،
 * التذييل، والباركود — ثم يمررها للطبقة الأصلية
 * (PlatformUtilsModule.exportReceiptImage) التي ترسمها بخط Tajawal
 * على «ورقة» بيضاء بمقاس الورق الحقيقي (58/80مم ×2 دقة) وتحفظها
 * PNG في مجلد التنزيلات. الغرض: يرى التاجر شكل فاتورته المطبوعة
 * قبل أن يطبعها — بطلب التاجر نصاً («زر يستطيع المستخدم تحميل
 * شكل الفاتورة كصورة فقط توضح شكل الفاتورة التي سوف يتم
 * طباعتها»).
 *
 * البيانات نموذجية (فاتورة توضيحية بأصناف عربية واقعية) لكن كل
 * إعدادات المتجر حقيقية: الاسم، الهاتف، الشعار، عرض الورق،
 * الرسالة الختامية، وإظهار الربح.
 */
import {PlatformUtilsNative} from '../../native/nativeBridge';
import {formatDateTime, formatMoney, localNow} from '../../core/format';
import {APP_NAME} from '../../core/config';
import type {ReceiptSettings} from './receipt';

/** صف واحد من صفوف الفاتورة (يفهمها المولّد الأصلي). */
export type ReceiptPreviewRow =
  | {t: 'logo'; path: string}
  | {
      t: 'text';
      text: string;
      align: 'center' | 'right' | 'left';
      bold?: boolean;
      size?: 0 | 1 | 2;
    }
  | {t: 'two'; label: string; value: string; bold?: boolean}
  | {t: 'sep'}
  | {t: 'barcode'; value: string}
  | {t: 'space'; h: number};

/** بنية الحمولة الكاملة للطبقة الأصلية. */
export interface ReceiptPreviewPayload {
  paper: '58' | '80';
  rows: ReceiptPreviewRow[];
}

/** أصناف النموذج — فاتورة بقالة واقعية بأحجام عربية. */
const SAMPLE_ITEMS: {
  name: string;
  qty: number;
  unitPrice: number;
  unitName?: string;
}[] = [
  {name: 'حليب المراعي ١ لتر', qty: 2, unitPrice: 6.5},
  {name: 'خبز عربي', qty: 3, unitPrice: 3},
  {name: 'شوكولاتة بالحليب 40 جرام', qty: 2, unitPrice: 4.5},
  {name: 'عصير برتقال طبيعي', qty: 1, unitPrice: 7},
  {name: 'مياه معدنية', qty: 6, unitPrice: 2, unitName: 'قنينة'},
];

/**
 * يبني صفوف معاينة الفاتورة من إعدادات المتجر الحية — مرآة
 * buildReceiptJob في receipt.ts بنفس الترتيب والمحتوى.
 */
export function buildReceiptPreviewRows(
  settings: ReceiptSettings,
): ReceiptPreviewRow[] {
  const rows: ReceiptPreviewRow[] = [];

  // ── الشعار (اختياري) ──
  if (settings.storeLogoPath) {
    rows.push({t: 'logo', path: settings.storeLogoPath});
  }

  // ── الترويسة ──
  rows.push({
    t: 'text',
    text: settings.storeName || APP_NAME,
    align: 'center',
    bold: true,
    size: 1,
  });
  if (settings.storePhone.trim()) {
    rows.push({
      t: 'text',
      text: `هاتف: ${settings.storePhone.trim()}`,
      align: 'center',
    });
  }
  rows.push({t: 'text', text: APP_NAME, align: 'center'});
  rows.push({t: 'sep'});

  // ── رقم الفاتورة والتاريخ والوضع ──
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const sampleNumber = `INV-${now.getFullYear()}${
    String(now.getMonth() + 1).padStart(2, '0')
  }${day}-0001`;
  rows.push({
    t: 'text',
    text: `فاتورة: ${sampleNumber}`,
    align: 'right',
    bold: true,
  });
  rows.push({
    t: 'text',
    text: `التاريخ: ${formatDateTime(localNow())}`,
    align: 'right',
  });
  rows.push({t: 'text', text: 'بيع مفرق', align: 'right'});
  rows.push({t: 'sep'});

  // ── الأصناف: الاسم يميناً ثم سطر الكمية×السعر=القيمة ──
  let subtotal = 0;
  for (const item of SAMPLE_ITEMS) {
    const lineTotal = item.qty * item.unitPrice;
    subtotal += lineTotal;
    rows.push({
      t: 'text',
      text: `${item.name}${item.unitName ? ` (${item.unitName})` : ''}`,
      align: 'right',
    });
    rows.push({
      t: 'two',
      label: `${item.qty} × ${formatMoney(item.unitPrice)}`,
      value: formatMoney(lineTotal),
    });
  }

  // ── المجاميع ──
  const discount = 2;
  const total = subtotal - discount;
  rows.push({t: 'sep'});
  rows.push({
    t: 'two',
    label: 'المجموع',
    value: formatMoney(subtotal),
  });
  rows.push({t: 'two', label: 'الخصم', value: formatMoney(discount)});
  rows.push({
    t: 'two',
    label: 'الإجمالي',
    value: formatMoney(total),
    bold: true,
  });

  // الربح الصافي — فقط عند تفعيل إظهاره (للمدير).
  if (settings.showProfit) {
    rows.push({t: 'two', label: 'الربح الصافي', value: formatMoney(8.5)});
  }

  // ── التذييل ──
  rows.push({t: 'sep'});
  rows.push({
    t: 'text',
    text: settings.footerMessage || 'شكراً لتعاملكم معنا — عداكم خيراً',
    align: 'center',
  });
  rows.push({t: 'text', text: 'شكراً لكم!', align: 'center', bold: true});
  rows.push({t: 'barcode', value: sampleNumber});

  return rows;
}

/**
 * يبني الحمولة ويطلب من الطبقة الأصلية رسمها وحفظها PNG في
 * مجلد التنزيلات — يعيد مسار الصورة للعرض في التوست.
 */
export async function exportReceiptPreviewImage(
  settings: ReceiptSettings,
): Promise<string> {
  if (PlatformUtilsNative == null) {
    throw new Error('وحدة التصدير غير متوفرة في هذا الإصدار');
  }
  const payload: ReceiptPreviewPayload = {
    paper: settings.paperWidth,
    rows: buildReceiptPreviewRows(settings),
  };
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(
    2,
    '0',
  )}${String(now.getDate()).padStart(2, '0')}-${String(
    now.getHours(),
  ).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(
    now.getSeconds(),
  ).padStart(2, '0')}`;
  return PlatformUtilsNative.exportReceiptImage(
    `receipt-preview-${settings.paperWidth}mm-${stamp}.png`,
    JSON.stringify(payload),
  );
}
