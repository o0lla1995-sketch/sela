/**
 * ESC/POS receipt job builder.
 * ─────────────────────────────────────────────────────────────────
 * Produces the structured op array consumed by the native
 * ThermalPrinterModule.printJob(). Layout helpers are bidi-safe:
 * Arabic product names are emitted as their own right-aligned lines,
 * quantities/amounts as pure ASCII lines so cheap printer firmware
 * never has to reorder mixed bidi runs.
 */
import type {EscPosOp} from '../../native/nativeBridge';
import {formatAmount} from '../../core/format';

export class ReceiptBuilder {
  private ops: EscPosOp[] = [];

  static create(): ReceiptBuilder {
    const builder = new ReceiptBuilder();
    builder.ops.push({op: 'init'});
    return builder;
  }

  codepage(page: number): this {
    this.ops.push({op: 'codepage', page});
    return this;
  }

  /** 0 = left, 1 = center, 2 = right */
  align(value: 0 | 1 | 2): this {
    this.ops.push({op: 'align', align: value});
    return this;
  }

  bold(on: boolean): this {
    this.ops.push({op: 'bold', on});
    return this;
  }

  /** Double width/height flags for headers and totals. */
  size(width: 0 | 1, height: 0 | 1): this {
    this.ops.push({op: 'size', width, height});
    return this;
  }

  text(value: string): this {
    this.ops.push({op: 'text', value});
    return this;
  }

  textLine(value: string): this {
    this.ops.push({op: 'text', value: `${value}\n`});
    return this;
  }

  feed(lines = 1): this {
    this.ops.push({op: 'feed', lines});
    return this;
  }

  cut(): this {
    this.ops.push({op: 'cut'});
    return this;
  }

  /** Raster image (store logo): GS v 0, centered, dithered natively. */
  image(path: string, maxWidth: number): this {
    this.ops.push({op: 'image', path, maxWidth, center: true});
    return this;
  }

  /**
   * v9.1 (round-14 #6): native ESC/POS barcode (GS k function B) —
   * used for product LABEL printing. EAN13 takes 12 digits (the
   * printer computes + prints the check digit); CODE128 takes any
   * ASCII payload. Height is in dots (24–162, typical label 72).
   *
   * v41 (الجولة 49 #2): moduleWidth (GS w) — عرض الوحدة بالنقاط.
   * الطابعة لا تقلّص الباركود تلقائياً؛ بدون GS w صريح يُطبع
   * بالعرض الافتراضي للثابتة (3 غالباً) فباركود CODE128 طويل
   * كرقم الفاتورة (222 وحدة) يتجاوز عرض ورق 58مم ويخرج مشوهاً
   * لا يقرؤه الماسح. المُرِر يحسب العرض الأقصى الذي يتسع داخل
   * الورق ويمرره هنا.
   */
  barcode(
    system: 'EAN13' | 'CODE128',
    value: string,
    heightDots = 72,
    moduleWidth = 2,
  ): this {
    this.ops.push({
      op: 'barcode',
      system,
      value,
      height: heightDots,
      width: moduleWidth,
    });
    return this;
  }

  /** v41 (الجولة 49 #2): عدد وحدات (modules) باركود CODE128-B
   *  للحمولة: START(11) + n×11 (البيانات) + CHECK(11) + STOP(13)
   *  = 11n + 35 — يُستخدم لحساب عرض الوحدة الأقصى الذي يتسع
   *  داخل عرض الورق قبل أن يتشوه الباركود أو يُقص. */
  code128Modules(payloadLength: number): number {
    return 11 * payloadLength + 35;
  }

  /** v41 (الجولة 49 #2): أكبر عرض وحدة (GS w) يتسع به باركود
   *  داخل عرض الورق بالنقاط (rasterWidth: 58مم=384، 80مم=576)
   *  مع هامش أمان — ولا يقل عن 1 ولا يزيد عن 3 (فوق 3 تتسع
   *  الأشرطة عبثاً وتستهلك الورق). */
  barcodeModuleWidthFor(modules: number, rasterWidth: number): number {
    const usable = Math.max(48, rasterWidth - 32);
    return Math.max(1, Math.min(3, Math.floor(usable / Math.max(1, modules))));
  }

  /** A dashed separator across the paper width. */
  separator(width: number, char = '-'): this {
    return this.textLine(char.repeat(Math.max(8, width)));
  }

  /** Blank spacing line. */
  blank(): this {
    return this.textLine('');
  }

  /**
   * Two-column money line — ASCII label + dotted leaders + amount,
   * e.g. "TOTAL ........ 45.00" (bidi-safe on any printer firmware).
   */
  twoColumns(label: string, amount: number | string, width: number): this {
    const amountText =
      typeof amount === 'number' ? formatAmount(amount) : amount;
    const labelPart =
      label.length <= width - 4
        ? label
        : label.slice(0, Math.max(4, width - 4));
    const dots = Math.max(1, width - labelPart.length - amountText.length - 1);
    return this.textLine(`${labelPart} ${'.'.repeat(dots)} ${amountText}`);
  }

  /** Product line: "2 x 4.50 = 9.00" (pure ASCII, right-aligned). */
  qtyPriceLine(quantity: number, unitPrice: number, total: number): this {
    // v8.3: weight lines carry fractional kg — 1.25 x 12.00 = 15.00
    // (trim trailing zeros, keep up to 3 decimals).
    const qty = Number(quantity.toFixed(3));
    return this.textLine(
      `${qty} x ${formatAmount(unitPrice)} = ${formatAmount(total)}`,
    );
  }

  /** Truncates by code points, safe for Arabic. */
  truncate(value: string, max: number): this {
    return this.textLine(
      value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`,
    );
  }

  build(): EscPosOp[] {
    return [...this.ops];
  }
}
