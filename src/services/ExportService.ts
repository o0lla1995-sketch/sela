/**
 * ExportService — local CSV / XLS report generation.
 * ─────────────────────────────────────────────────────────────────
 * CSV: UTF-8 with BOM so Excel opens Arabic text correctly.
 * XLS: SpreadsheetML 2003 (a single XML file) — opens natively in
 * Microsoft Excel and LibreOffice, zero dependencies, fully offline.
 */
import {requirePlatformUtils} from '../native/nativeBridge';
import {ReportService} from './ReportService';
import {ProductRepo} from '../database/repositories/ProductRepo';
import {StocktakeRepo} from '../database/repositories/StocktakeRepo';
import {SaleRepo} from '../database/repositories/SaleRepo';
import {MerchantRepo} from '../database/repositories/MerchantRepo';
import {localToday} from '../core/format';
import {paymentMethodLabel} from '../core/paymentMethods';
import type {ReportRangeKey, DateRange, Product} from '../core/types';

const CSV_BOM = '\uFEFF';

function csvEscape(value: string | number): string {
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function rowsToCsv(rows: (string | number)[][]): string {
  const body = rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
  return CSV_BOM + body + '\r\n';
}

function xmlEscape(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function rowsToXls(
  rows: (string | number)[][],
  sheetName: string,
): string {
  const header = rows[0] ?? [];
  const bodyRows = rows.slice(1);
  const xmlRows = bodyRows
    .map(row => {
      const cells = header
        .map((_, index) => {
          const cell = row[index] ?? '';
          const isNumber = typeof cell === 'number';
          const dataType = isNumber ? 'Number' : 'String';
          const content = isNumber ? String(cell) : xmlEscape(cell);
          return `<Cell><Data ss:Type="${dataType}">${content}</Data></Cell>`;
        })
        .join('');
      return `<Row>${cells}</Row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\r\n' +
    '<?mso-application progid="Excel.Sheet"?>\r\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
    'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    `<Worksheet ss:Name="${xmlEscape(sheetName)}">` +
    '<Table>' +
    `<Row>${header
      .map(
        cell =>
          `<Cell><Data ss:Type="String">${xmlEscape(
            String(cell),
          )}</Data></Cell>`,
      )
      .join('')}</Row>` +
    xmlRows +
    '</Table></Worksheet></Workbook>'
  );
}

async function exportRows(
  baseName: string,
  rows: (string | number)[][],
  format: 'csv' | 'xls',
): Promise<string> {
  if (rows.length <= 1) {
    throw new Error('لا توجد بيانات لتصديرها في هذه الفترة');
  }
  const platform = requirePlatformUtils();
  const stamp = localToday().replace(/-/g, '');
  const fileName = `${baseName}_${stamp}.${format}`;
  const mimeType = format === 'csv' ? 'text/csv' : 'application/vnd.ms-excel';
  const content =
    format === 'csv' ? rowsToCsv(rows) : rowsToXls(rows, baseName);
  return platform.exportFile(fileName, mimeType, content);
}

export const ExportService = {
  /** Detailed sales report (invoices) for the selected range.
   *  v63 (الجولة 75 #9): عمود طريقة الدفع (بنك/محفظة/نقدي) —
   *  جدول حقيقي كامل بصف إجماليات أسفله (طلب التاجر: استخراج
   *  منسق بشكل صحيح على حسب التقرير المستخرج). */
  async exportSalesReport(
    key: ReportRangeKey,
    custom: DateRange | undefined,
    format: 'csv' | 'xls',
  ): Promise<string> {
    const details = await ReportService.salesDetail(key, custom);
    const rows: (string | number)[][] = [
      [
        'رقم الفاتورة',
        'التاريخ والوقت',
        'عدد الأصناف',
        'إجمالي القطع',
        'الإجمالي (₪)',
        'التكلفة (₪)',
        'صافي الربح (₪)',
        'الخصم (₪)',
        'نوع البيع',
        'طريقة الدفع',
      ],
      ...details.map(row => [
        row.invoice,
        row.createdAt,
        row.itemsCount,
        row.quantity,
        row.total.toFixed(2),
        row.cost.toFixed(2),
        row.profit.toFixed(2),
        row.discount.toFixed(2),
        row.paymentType,
        paymentMethodLabel(row.paymentMethod === '—' ? null : row.paymentMethod),
      ]),
      [
        'الإجماليات',
        '',
        '',
        details.reduce((sum, row) => sum + row.quantity, 0),
        details.reduce((sum, row) => sum + row.total, 0).toFixed(2),
        details.reduce((sum, row) => sum + row.cost, 0).toFixed(2),
        details.reduce((sum, row) => sum + row.profit, 0).toFixed(2),
        details.reduce((sum, row) => sum + row.discount, 0).toFixed(2),
        '',
        '',
      ],
    ];
    return exportRows('sales_report', rows, format);
  },

  /** Full stocktake report: system vs counted vs variance per product. */
  async exportStocktakeReport(stocktakeId: number): Promise<string> {
    const session = await StocktakeRepo.getById(stocktakeId);
    if (session == null) {
      throw new Error('جلسة الجرد غير موجودة');
    }
    const items = await StocktakeRepo.listItems(stocktakeId);
    const rows: (string | number)[][] = [
      ['المنتج', 'كمية النظام', 'الكمية المعدودة', 'الفرق', 'الحالة'],
      ...items.map(item => {
        const counted = item.counted_qty;
        const variance = counted == null ? 0 : counted - item.system_qty;
        const state =
          counted == null
            ? 'لم يُعد'
            : variance === 0
            ? 'مطابق'
            : variance > 0
            ? 'زيادة'
            : 'نقص';
        return [
          item.productName,
          item.system_qty,
          counted ?? '',
          variance ?? '',
          state,
        ];
      }),
      [
        'الإجمالي',
        items.reduce((sum, item) => sum + item.system_qty, 0),
        items.reduce((sum, item) => sum + (item.counted_qty ?? 0), 0),
        items.reduce(
          (sum, item) =>
            sum +
            (item.counted_qty == null ? 0 : item.counted_qty - item.system_qty),
          0,
        ),
        `جلسة #${session.id} — بدأت ${session.started_at}`,
      ],
    ];
    const platform = requirePlatformUtils();
    const stamp = localToday().replace(/-/g, '');
    const fileName = `stocktake_${session.id}_${stamp}.csv`;
    return platform.exportFile(fileName, 'text/csv', rowsToCsv(rows));
  },

  /** Top products report (by revenue & profit). */
  async exportTopProducts(
    key: ReportRangeKey,
    custom: DateRange | undefined,
    format: 'csv' | 'xls',
  ): Promise<string> {
    const bundle = await ReportService.loadBundle(key, custom);
    const rows: (string | number)[][] = [
      ['المنتج', 'الكمية المبيعة', 'الإيرادات (₪)', 'صافي الربح (₪)'],
      ...bundle.topByRevenue.map(row => [
        row.name,
        row.quantity,
        row.revenue.toFixed(2),
        row.profit.toFixed(2),
      ]),
    ];
    return exportRows('top_products', rows, format);
  },

  /** Full inventory snapshot with all three price levels. */
  async exportInventory(format: 'csv' | 'xls'): Promise<string> {
    const products: Product[] = await ProductRepo.list();
    const rows: (string | number)[][] = [
      [
        'اسم المنتج',
        'سعر التكلفة (₪)',
        'سعر المفرق (₪)',
        'سعر الجملة (₪)',
        'الكمية المتوفرة',
        'قيمة المخزون بالتكلفة (₪)',
      ],
      ...products.map(product => [
        product.name,
        product.cost_price.toFixed(2),
        product.retail_price.toFixed(2),
        product.wholesale_price.toFixed(2),
        product.stock_quantity,
        (product.cost_price * product.stock_quantity).toFixed(2),
      ]),
      [
        'الإجمالي',
        '',
        '',
        '',
        products.reduce((sum, product) => sum + product.stock_quantity, 0),
        products
          .reduce(
            (sum, product) => sum + product.cost_price * product.stock_quantity,
            0,
          )
          .toFixed(2),
      ],
    ];
    return exportRows('inventory', rows, format);
  },

  /** Full local backup: inventory + recent sales in one CSV file. */
  async exportBackup(): Promise<string> {
    const products: Product[] = await ProductRepo.list();
    const sales = await SaleRepo.listRecent(500);
    const rows: (string | number)[][] = [
      ['نسخة احتياطية - سيلا', ''],
      ['', ''],
      ['المنتجات', ''],
      ['اسم المنتج', 'التكلفة', 'المفرق', 'الجملة', 'الكمية', 'حد التنبيه'],
      ...products.map(p => [
        p.name,
        p.cost_price.toFixed(2),
        p.retail_price.toFixed(2),
        p.wholesale_price.toFixed(2),
        p.stock_quantity,
        p.low_stock_threshold ?? '',
      ]),
      ['', ''],
      ['آخر المبيعات', ''],
      [
        'رقم الفاتورة',
        'الإجمالي',
        'التكلفة',
        'الربح',
        'الخصم',
        'النوع',
        'التاريخ',
      ],
      ...sales.map(s => [
        s.invoice_number,
        s.total_amount.toFixed(2),
        s.total_cost.toFixed(2),
        s.total_profit.toFixed(2),
        s.discount.toFixed(2),
        s.payment_type,
        s.created_at,
      ]),
    ];
    return exportRows('sela_backup', rows, 'csv');
  },

  /** v79 (الجولة 92 #٣): كشف حساب تاجر واحد — كل الحركات بالرصيد
   *  الجاري بعد كل حركة (الأقدم أولاً كما في الدفاتر المحاسبية)
   *  مع صف إجماليات أسفل الجدول. */
  async exportMerchantStatement(
    merchantId: number,
    format: 'csv' | 'xls',
  ): Promise<string> {
    const merchant = await MerchantRepo.byId(merchantId);
    if (merchant == null) {
      throw new Error('حساب التاجر غير موجود');
    }
    // الكشف يُبنى تصاعدياً (الأقدم أولاً) — نعكس تسلسل العرض.
    const statement = (await MerchantRepo.statement(merchantId, 2000)).slice()
      .reverse();
    if (statement.length === 0) {
      throw new Error('لا حركات في كشف حساب هذا التاجر بعد');
    }
    const rows: (string | number)[][] = [
      [`كشف حساب التاجر — ${merchant.name}`],
      [
        merchant.phone ? `جوال: ${merchant.phone}` : '',
        merchant.id_number ? `هوية: ${merchant.id_number}` : '',
      ],
      [],
      [
        'التاريخ والوقت',
        'نوع الحركة',
        'المرجع',
        'موجب (علينا له) (₪)',
        'سالب (له عندنا) (₪)',
        'قناة السداد',
        'سند الخزينة',
        'البيان / البنود',
        'الرصيد الجاري (₪)',
      ],
      ...statement.map(row => {
        const positive =
          row.movement.kind === 'invoice' || row.movement.kind === 'debt';
        const itemsText =
          row.movement.items
            ?.map(item => `${item.name} ×${item.qty}`)
            .join(' · ') ?? '';
        return [
          row.movement.createdAt,
          MERCHANT_KIND_LABELS[row.movement.kind] ?? row.movement.kind,
          row.movement.ref,
          positive ? row.movement.amount.toFixed(2) : '',
          positive ? '' : row.movement.amount.toFixed(2),
          row.movement.method != null && row.movement.method !== 'cash'
            ? paymentMethodLabel(row.movement.method)
            : row.movement.method === 'cash'
            ? 'نقدي'
            : '',
          row.movement.cashRef ?? '',
          [row.movement.note ?? '', itemsText].filter(Boolean).join(' — '),
          row.runningBalance.toFixed(2),
        ];
      }),
      [],
      [
        'الإجماليات',
        '',
        '',
        statement
          .filter(
            row =>
              row.movement.kind === 'invoice' || row.movement.kind === 'debt',
          )
          .reduce((sum, row) => sum + row.movement.amount, 0)
          .toFixed(2),
        statement
          .filter(
            row =>
              row.movement.kind !== 'invoice' && row.movement.kind !== 'debt',
          )
          .reduce((sum, row) => sum + row.movement.amount, 0)
          .toFixed(2),
        '',
        '',
        '',
        `الرصيد الحالي: ${(statement[statement.length - 1]?.runningBalance ??
          0).toFixed(2)} ₪`,
      ],
    ];
    return exportRows(
      `merchant_${merchant.name.replace(/\s+/g, '_')}`,
      rows,
      format,
    );
  },

  /** v79 (الجولة 92 #٣): دفتر التجار ككل — سطر لكل تاجر برصيده
   *  وتفكيكه الكامل، ثم إجمالي المستحقات في أسفل الجدول. */
  async exportMerchantsBook(format: 'csv' | 'xls'): Promise<string> {
    const list = await MerchantRepo.listWithBalances();
    if (list.length === 0) {
      throw new Error('لا تجار مسجلون بعد');
    }
    const rows: (string | number)[][] = [
      ['دفتر حسابات التجار — سيلا'],
      [],
      [
        'التاجر',
        'الجوال',
        'الهوية',
        'فواتير التوريد (₪)',
        'ديون مباشرة (₪)',
        'سداد (₪)',
        'مرتجع/خصم (₪)',
        'تحصيل (₪)',
        'الرصيد الحالي (₪)',
        'حالة الرصيد',
        'آخر حركة',
      ],
      ...list.map(entry => [
        entry.merchant.name,
        entry.merchant.phone ?? '',
        entry.merchant.id_number ?? '',
        entry.invoiceTotal.toFixed(2),
        entry.debtTotal.toFixed(2),
        entry.paymentTotal.toFixed(2),
        entry.returnTotal.toFixed(2),
        entry.collectionTotal.toFixed(2),
        entry.balance.toFixed(2),
        entry.balance > 0.005
          ? 'مستحق له'
          : entry.balance < -0.005
          ? 'لك عنده'
          : 'مسدد',
        entry.lastAt ?? 'لا حركات',
      ]),
      [],
      [
        'الإجماليات',
        '',
        '',
        list.reduce((sum, e) => sum + e.invoiceTotal, 0).toFixed(2),
        list.reduce((sum, e) => sum + e.debtTotal, 0).toFixed(2),
        list.reduce((sum, e) => sum + e.paymentTotal, 0).toFixed(2),
        list.reduce((sum, e) => sum + e.returnTotal, 0).toFixed(2),
        list.reduce((sum, e) => sum + e.collectionTotal, 0).toFixed(2),
        list.reduce((sum, e) => sum + e.balance, 0).toFixed(2),
        `مستحق للتجار: ${list
          .reduce((sum, e) => sum + Math.max(0, e.balance), 0)
          .toFixed(2)} ₪ · لك عند التجار: ${list
          .reduce((sum, e) => sum + Math.max(0, -e.balance), 0)
          .toFixed(2)} ₪`,
        '',
      ],
    ];
    return exportRows('merchants_book', rows, format);
  },
};

/** تسميات أنواع حركات التاجر في التصدير. */
const MERCHANT_KIND_LABELS: Record<string, string> = {
  invoice: 'فاتورة توريد',
  payment: 'سداد له',
  return: 'مرتجع/خصم',
  collection: 'تحصيل منه',
  debt: 'دين مستحق مباشر',
};
