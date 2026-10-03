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
import {localToday} from '../core/format';
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
  /** Detailed sales report (invoices) for the selected range. */
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
};
