/**
 * Product label job builder — v9.1 (round-14 #6).
 * ─────────────────────────────────────────────────────────────────
 * The label a merchant sticks on the shelf/parcel: product name
 * (bold), price (double-size), a scannable barcode (native GS k —
 * EAN-13 when the code is a valid 13-digit, CODE128 otherwise) and
 * the code as text. `copies` repeats the whole block with a cut
 * between copies — printing a sheet of identical labels in one job.
 */
import {ReceiptBuilder} from './escpos';
import {formatAmount} from '../../core/format';
import {LABEL_BARCODE_HEIGHT_DOTS} from '../../core/config';
import {isValidEan13} from '../BarcodeService';

/** v41 (الجولة 49 #2): عرض ورق الملصق بالنقاط — لحساب عرض وحدة
 *  الباركود (GS w) الذي يتسع داخل الورق قبل الطباعة. */
const labelRasterWidth = (paper: '58' | '80') => (paper === '58' ? 384 : 576);

/** v41: عدد وحدات EAN13 الثابت (95 وحدة — حتمي في المعيار). */
const EAN13_MODULES = 95;

export interface LabelData {
  productName: string;
  /** Price shown on the label (₪). */
  price: number;
  /** Optional per-label note under the price (e.g. سعر الكيلو). */
  priceNote?: string | null;
  barcode: string;
  /** How many identical labels to print. */
  copies: number;
}

export interface LabelSettings {
  paperWidth: '58' | '80';
  codepage: number;
}

export function buildLabelJob(data: LabelData, settings: LabelSettings) {
  const width = settings.paperWidth === '58' ? 32 : 48;
  const b = ReceiptBuilder.create();
  const copies = Math.max(1, Math.min(20, Math.round(data.copies)));

  for (let copy = 0; copy < copies; copy++) {
    b.codepage(settings.codepage)
      .align(1)
      .bold(true)
      // Name first (right-aligned Arabic on its own line, bidi-safe).
      .align(1)
      .truncate(data.productName, width)
      .bold(false)
      .size(1, 1)
      .align(1)
      .textLine(`${formatAmount(data.price)} ILS`)
      .size(0, 0);
    if (data.priceNote != null && data.priceNote.length > 0) {
      b.align(1).textLine(data.priceNote);
    }
    if (data.barcode.trim().length > 0) {
      // v41 (الجولة 49 #2): عرض وحدة GS w محسوب يتسع داخل الورق —
      //  باركود طويل بعرض افتراضي يتجاوز الملصق فيخرج مشوهاً.
      const isEan = isValidEan13(data.barcode);
      const modules = isEan
        ? EAN13_MODULES
        : b.code128Modules(data.barcode.length);
      const moduleWidth = b.barcodeModuleWidthFor(
        modules,
        labelRasterWidth(settings.paperWidth),
      );
      b.align(1)
        .barcode(
          isEan ? 'EAN13' : 'CODE128',
          data.barcode,
          LABEL_BARCODE_HEIGHT_DOTS,
          moduleWidth,
        )
        .align(1)
        .bold(true)
        .textLine(data.barcode)
        .bold(false);
    }
    b.feed(2).cut().feed(1);
  }
  return b.build();
}
