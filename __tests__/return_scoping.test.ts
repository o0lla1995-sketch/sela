/**
 * return_scoping.test.ts — v3.1 (الجولة 65): حرّوس ربط المرتجعات.
 * ─────────────────────────────────────────────────────────────────
 * الجذر الذي منع الإرجاع: استعلام المتبقي كان يعدّ مرتجعات كل
 * الفواتير الأخرى التي تتشارك رقم المنتج نفسه (وليس مرتجعات هذه
 * الفاتورة فقط)، وكان يخصم المرتجعات المتزامنة مرتين من لقطة
 * الخادم. هذه الحرّوس تُثبّت السلوك الجديد:
 *  ① الاستعلام يقيَّد بـ source_ref = فاتورة المصدر.
 *  ② التطابق بالتوقيع الكامل (منتج + متغير + وحدة).
 *  ③ onlyPending مع لقطة الخادم (المتزامنة محسوبة داخلها أصلاً).
 * ④ recordLocalOp يخزّن source_ref مع المرتجع.
 */
interface CapturedCall {
  kind: 'select' | 'run' | 'tx';
  sql: string;
  params: unknown[];
}

// كل شيء داخل مصنع المحاكاة — بلا متغيرات خارج نطاقه (قواعد
// jest.mock): __captured يقرأه الاختبار عبر requireMock.
jest.mock('../src/native', () => {
  const actual = jest.requireActual('../src/native');
  const captured: CapturedCall[] = [];
  const localDb = {
    async select(sql: string, params: unknown[] = []) {
      captured.push({kind: 'select', sql, params});
      return [];
    },
    async run(sql: string, params: unknown[] = []) {
      captured.push({kind: 'run', sql, params});
      return {insertId: 1, rowsAffected: 1};
    },
    async tx(statements: {sql: string; params?: unknown[]}[]) {
      for (const statement of statements) {
        captured.push({
          kind: 'tx',
          sql: statement.sql,
          params: statement.params ?? [],
        });
      }
      return true;
    },
  };
  return {...actual, localDb, __captured: captured};
});

import {recordLocalOp, returnedQtyForLine} from '../src/store/offline';

const captured = (jest.requireMock('../src/native') as {
  __captured: CapturedCall[];
}).__captured;

function lastCall(kind: CapturedCall['kind']): CapturedCall {
  const hit = [...captured].reverse().find(call => call.kind === kind);
  if (hit == null) {
    throw new Error('لم يُلتقط أي استدعاء من النوع المطلوب');
  }
  return hit;
}

beforeEach(() => {
  captured.length = 0;
});

describe('v3.1 — ترحيل القاعدة: عمود source_ref', () => {
  test('يُضاف لتثبيتات القواعد القديمة (أول تهيئة في الملف)', async () => {
    // أول استدعاء في الملف يشغّل initOfflineStore: CREATE + ALTER.
    // العلم المزدوج (initialized) يمنع تكرارها لاحقاً — لذا هذا
    // الحرّوس أول اختبار في الملف عمداً.
    await returnedQtyForLine('C-dev-1', 7, null, null, false);
    const alter = captured.find(
      call => call.kind === 'run' && call.sql.includes('ALTER TABLE invoices'),
    );
    expect(alter).toBeDefined();
    expect(alter!.sql).toContain('ADD COLUMN source_ref TEXT');
  });
});

describe('v3.1 — تقييد المتبقي بفاتورة المصدر (source_ref)', () => {
  test('الاستعلام يقيد المرتجعات على فاتورة المصدر نفسها', async () => {
    await returnedQtyForLine('C-dev-1', 7, null, null, false);
    const call = lastCall('select');
    expect(call.sql).toContain('i.source_ref = ?');
    expect(call.params[0]).toBe('C-dev-1');
    // التوقيع الكامل: منتج + متغير + وحدة.
    expect(call.sql).toContain('ii.product_id = ?');
    expect(call.sql).toContain('ii.variant_label = ?');
    expect(call.sql).toContain('ii.unit_name = ?');
    // بلا لقطة خادم: كل المرتجعات غير المرفوضة تُعدّ.
    expect(call.sql).toContain("i.status != 'rejected'");
  });

  test('مع لقطة الخادم: المعلّقة فقط (المتزامنة داخل اللقطة أصلاً)', async () => {
    await returnedQtyForLine('C-dev-2', 9, 'أسود · L', 'حبة', true);
    const call = lastCall('select');
    expect(call.sql).toContain("i.status = 'pending'");
    expect(call.params).toEqual([
      'C-dev-2',
      9,
      'أسود · L',
      'أسود · L',
      'حبة',
      'حبة',
    ]);
  });
});

describe('v3.1 — تسجيل المرتجع بفاتورته المصدر', () => {
  test('recordLocalOp يخزّن source_ref في صف المرتجع', async () => {
    await recordLocalOp({
      ref: 'C-dev-9',
      kind: 'return',
      displayNumber: 'م-ر-م-3',
      payKind: 'refund',
      total: -12,
      discount: 0,
      customerName: null,
      createdAt: '2026-10-19 10:00:00',
      sourceRef: 'C-dev-3',
      lines: [
        {
          productId: 7,
          name: 'عصير',
          variantId: null,
          variantLabel: null,
          unitId: null,
          unitName: 'حبة',
          quantity: 2,
          unitPrice: 4.8,
          lineTotal: 9.6,
        },
      ],
      payload: {saleClientRef: 'C-dev-3', lines: []},
    });
    const insert = captured.find(
      call => call.kind === 'tx' && call.sql.includes('INSERT INTO invoices'),
    );
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain('source_ref');
    // آخر معامل = sourceRef (بعد createdAt).
    expect(insert!.params[insert!.params.length - 1]).toBe('C-dev-3');
  });
});

/* ────────────────────────────────────────────────────────────────
 * v3.4.1 (الجولة 78 — كاشير #3): حرس التكافؤ الحرفي بين جمل SQL
 * ومعاملاتها. الجذر: INSERT الفواتير حمل 15 قيمة لـ14 عموداً
 * (علامة ? زائدة) فرفضها SQLite على الجهاز برسالة
 * «15 values for 14 columns (SQLITE_ERROR)» عند البيع دون اتصال
 * مع اختيار طريقة الدفع — والمحاكاة في الاختبارات لا تُصرِّف SQL
 * أبداً فمرّ الخطأ دون حرّوس. هنا نحاكي فحص SQLite نفسه: عدد
 * علامات الاستفهام في كل جملة داخل tx يجب أن يساوي عدد معاملاتها،
 * وعدد القيم في INSERT يساوي عدد أعمدته.
 * ──────────────────────────────────────────────────────────────── */
describe('v3.4.1 — تكافؤ علامات الاستفهام مع المعاملات (حرس SQLITE)', () => {
  test('كل جمل tx: عدد ? يساوي عدد المعاملات — البيع مع طريقة الدفع', async () => {
    await recordLocalOp({
      ref: 'C-dev-77',
      kind: 'sale',
      displayNumber: 'م-5',
      payKind: 'cash',
      payMethod: 'jawwal_pay',
      total: 48,
      discount: 2,
      customerName: 'أحمد',
      createdAt: '2026-10-28 09:30:00',
      lines: [
        {
          productId: 7,
          name: 'عصير',
          variantId: null,
          variantLabel: null,
          unitId: null,
          unitName: 'حبة',
          quantity: 10,
          unitPrice: 4.8,
          lineTotal: 48,
        },
      ],
      payload: {lines: []},
    });

    const txCalls = captured.filter(call => call.kind === 'tx');
    expect(txCalls.length).toBeGreaterThanOrEqual(3); // فاتورة + صنف + طابور

    for (const call of txCalls) {
      const placeholders = (call.sql.match(/\?/g) ?? []).length;
      expect(placeholders).toBe(call.params.length);
    }

    // جملة إدراج الفاتورة تحديداً: 15 عموداً تقابلها 15 قيمة و11
    // معاملات (NULL و'pending' حرفيان داخل الجملة).
    // v3.5 (الجولة 91): عمود customer_id انضم — الحرس يظل يعدّ
    // الأعمدة والقيم والمعاملات حرفياً كفحص SQLite نفسه.
    const invoiceInsert = txCalls.find(c =>
      c.sql.includes('INSERT INTO invoices'),
    );
    expect(invoiceInsert).toBeDefined();
    const columns = invoiceInsert!.sql.match(/\(([^)]+)\)\s*VALUES/s);
    expect(columns).toBeDefined();
    const columnCount = columns![1].split(',').length;
    const values = invoiceInsert!.sql.match(/VALUES\s*\(([^)]+)\)/s);
    expect(values).toBeDefined();
    const valueCount = values![1].split(',').length;
    expect(columnCount).toBe(15);
    expect(valueCount).toBe(15);
    // طريقة الدفع في موضعها الصحيح (العمود السابع، المعامل الخامس).
    expect(invoiceInsert!.params[4]).toBe('jawwal_pay');
    // اسم الزبون ثم معرّفه (معاملان متتاليان بعد الخصم) — دفتر
    // الدين المحلي المعلق يُبنى منهما (الجولة 91 — كاشير #2).
    expect(invoiceInsert!.params[7]).toBe('أحمد');
    expect(invoiceInsert!.params[8]).toBeNull();
    // ومصدر الربط آخر المعاملات.
    expect(invoiceInsert!.params[10]).toBeNull();
  });

  test('المرتجع دون اتصال: نفس التكافؤ مع source_ref', async () => {
    await recordLocalOp({
      ref: 'C-dev-78',
      kind: 'return',
      displayNumber: 'م-ر-م-6',
      payKind: 'refund',
      payMethod: 'cash',
      total: -9.6,
      discount: 0,
      customerName: null,
      createdAt: '2026-10-28 10:00:00',
      sourceRef: 'C-dev-77',
      lines: [],
      payload: {saleClientRef: 'C-dev-77', lines: []},
    });
    for (const call of captured.filter(c => c.kind === 'tx')) {
      const placeholders = (call.sql.match(/\?/g) ?? []).length;
      expect(placeholders).toBe(call.params.length);
    }
  });
});
