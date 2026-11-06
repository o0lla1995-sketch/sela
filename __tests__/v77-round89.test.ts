/**
 * v77 — الجولة 89: ثلاث ملاحظات التاجر على الجولة 88 نفسها.
 * ─────────────────────────────────────────────────────────────────
 *  ١. الرئيسية: «لا رايد قسم إجمالي في الخزينة الان احذفه وبدلا
 *     من قسم النقد بالخزينة اجعله إجمالي في الخزينة يعني بدلا من
 *     النقد يظهر الاجمالي» — الخلية الكبرى الأولى صارت الإجمالي
 *     (نقد + بنوك ومحافظ) والقسم الإضافي المنفصل من v76 حُذف.
 *  ٢. الخزينة: «احذف البنوك والمحافظ الان والتفاصيل الجديد واجعله
 *     بشكل عام يظهر بدلا من رقم النقد بالخزينة الان يظهر الاجمالي
 *     في الخزينة الان» — الرقم الكبير في بطاقة الخزينة صار الإجمالي
 *     وصندوق القنوات المنفصل حُذف.
 *  ٣. سجل الحركات: «لا اريد اظهار حركات تسوية قناة تعديل فاتورة
 *     ورد فرق تعديل فاتورة لأنها خارج اطار عمليات الخزينة» — سندات
 *     rewriteSale الداخلية (تحصيل/رد/تسوية قناة) تُخفى من السجل
 *     والعدّاد وإجماليات الفترة، وتبقى في دفتر الأرصدة (هي ما يوازن
 *     كشف كل قناة عند تعديل الفاتورة عبر قناتين).
 */
import {describe, expect, test} from '@jest/globals';
import {readFileSync} from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8') as string;

const HOME = 'src/screens/HomeScreen.tsx';
const CASH_SCREEN = 'src/screens/cash/CashMovementsScreen.tsx';
const CASH_REPO = 'src/database/repositories/CashRepo.ts';
const SALE_REPO = 'src/database/repositories/SaleRepo.ts';
const CONFIG = 'src/core/config.ts';
const GRADLE = 'android/app/build.gradle';

const SETTLEMENT_CATEGORIES = [
  'تحصيل فرق تعديل فاتورة',
  'رد فرق تعديل فاتورة',
  'تسوية قناة تعديل فاتورة',
] as const;

describe('v77 — ١ الرئيسية: الإجمالي في الخلية الكبرى بلا قسم منفصل', () => {
  test('الخلية الأولى «إجمالي في الخزينة» بقيمة treasuryTotalNow', () => {
    const src = read(HOME);
    expect(src).toContain('إجمالي في الخزينة</Text>');
    // القيمة المعروضة هي الإجمالي (نقد + بنوك ومحافظ) لا cashTotal.
    const heroIdx = src.indexOf('إجمالي في الخزينة</Text>');
    const heroBlock = src.slice(heroIdx, heroIdx + 400);
    expect(heroBlock).toContain('treasuryTotalNow');
    // المعادلة: الإجمالي = النقد + مجموع أرصدة القنوات.
    expect(src).toContain(
      'const methodsTotal = methodBalances.reduce((sum, ch) => sum + ch.balance, 0);',
    );
    expect(src).toContain('const treasuryTotalNow = cashTotal + methodsTotal;');
    // النص الفرعي يشرح التركيب — لا يعود يقول «مبيعات نقدية».
    expect(heroBlock).toContain('النقد بالدرج + البنوك والمحافظ');
  });

  test('قسم «إجمالي الخزينة الآن» المنفصل (v76) حُذف نهائياً', () => {
    const src = read(HOME);
    expect(src).not.toContain('إجمالي الخزينة الآن');
    expect(src).not.toContain('treasuryTotalRow');
    expect(src).not.toContain('treasuryTotalLabel');
    expect(src).not.toContain('treasuryTotalValue');
    // «النقد بالخزينة» كتسمية خلية كبرى زالت — تبقى التفاصيل
    // المنطوية بلا هذه العبورة.
    expect(src).not.toContain('>النقد بالخزينة</Text>');
  });

  test('شريط أرصدة القنوات التفصيلي باقٍ (الرصيد لكل قناة)', () => {
    const src = read(HOME);
    expect(src).toContain('channelChip');
    expect(src).toContain('channelBalance');
    expect(src).toContain('methodBalances.map(channel =>');
  });
});

describe('v77 — ٢ الخزينة: الرقم الكبير هو الإجمالي بلا صندوق منفصل', () => {
  test('البطاقة تحمل «الإجمالي في الخزينة الآن» وتجمع النقد والقنوات', () => {
    const src = read(CASH_SCREEN);
    expect(src).toContain('الإجمالي في الخزينة الآن</Text>');
    const heroIdx = src.indexOf('الإجمالي في الخزينة الآن</Text>');
    const heroBlock = src.slice(heroIdx, heroIdx + 520);
    // الإجمالي = drawerMinor + مجموع أرصدة القنوات.
    expect(heroBlock).toContain('(drawerMinor ?? 0) / 100 +');
    expect(heroBlock).toContain(
      'channelBalances.reduce((s, ch) => s + ch.balance, 0)',
    );
    // النص الفرعي يشرح التركيب.
    expect(heroBlock).toContain('النقد بالدرج + البنوك والمحافظ');
  });

  test('صندوق «البنوك والمحافظ الآن» المنفصل (v76) حُذف نهائياً', () => {
    const src = read(CASH_SCREEN);
    expect(src).not.toContain('البنوك والمحافظ الآن');
    expect(src).not.toContain('drawerChannelsBox');
    expect(src).not.toContain('drawerChannelsRow');
    expect(src).not.toContain('drawerChannelsValue');
    // تسمية «النقد المتوقع» زالت — الرقم الكبير صار الإجمالي.
    expect(src).not.toContain('النقد المتوقع بالخزينة الآن');
  });

  test('أرصدة القنوات ما زالت تُحمَّل (تغذي الرقم الكبير وسقوف السندات)', () => {
    const src = read(CASH_SCREEN);
    expect(src).toContain('setChannelBalances(balances);');
    expect(src).toContain('ReportService.methodBalanceNow(m.id)');
  });
});

describe('v77 — ٣ السجل: تسويات تعديل الفاتورة خارج إطار الخزينة', () => {
  test('الثابت في CashRepo يطابق حرفياً فئات INSERT في SaleRepo', () => {
    const repo = read(CASH_REPO);
    const sale = read(SALE_REPO);
    // الثابت معرَّف ومصدَّر.
    expect(repo).toContain(
      'export const INVOICE_EDIT_SETTLEMENT_CATEGORIES: readonly string[] = [',
    );
    // كل فئة من الثلاث موجودة في كلا الملفين — التطابق هو ما يجعل
    // الاستبعاد آمناً بلا معرف تقني إضافي.
    for (const category of SETTLEMENT_CATEGORIES) {
      expect(repo).toContain(`'${category}'`);
      expect(sale).toContain(`'${category}'`);
    }
  });

  test('list وcountFor يستبعدانها — العداد يطابق الصفوف المعروضة', () => {
    const repo = read(CASH_REPO);
    // الدالة المشتركة معرفة.
    expect(repo).toContain('function excludedSettlementClause(');
    expect(repo).toContain(
      'category NOT IN (${INVOICE_EDIT_SETTLEMENT_CATEGORIES.map(',
    );
    // list: الاستبعاد بعد فلتر النوع.
    const listIdx = repo.indexOf('async list(input: {');
    const listBlock = repo.slice(listIdx, listIdx + 900);
    expect(listBlock).toContain('excludedSettlementClause(clauses, params);');
    // countFor: نفس الاستبعاد.
    const countIdx = repo.indexOf('async countFor(');
    const countBlock = repo.slice(countIdx, countIdx + 800);
    expect(countBlock).toContain('excludedSettlementClause(clauses, params);');
  });

  test('totalsFor يستبعدها — إجماليات الكشف والتقارير بلا سندات داخلية', () => {
    const repo = read(CASH_REPO);
    const totalsIdx = repo.indexOf('async totalsFor(');
    const totalsBlock = repo.slice(totalsIdx, totalsIdx + 700);
    expect(totalsBlock).toContain('excludedSettlementClause(clauses, params);');
    // الاستعلام يبني WHERE من clauses (لا تاريخاً ثابتاً).
    expect(totalsBlock).toContain('WHERE ${clauses.join(\' AND \')}');
  });

  test('دفتر الأرصدة يبقى يشملها — المعادلة لا تنكسر', () => {
    const repo = read(CASH_REPO);
    const sale = read(SALE_REPO);
    // allTimeTotals (معادلة الدرج) بلا استبعاد — تسويات القناة
    // النقدية جزء من توازن الدرج نفسه.
    const allIdx = repo.indexOf('async allTimeTotals()');
    const allBlock = repo.slice(allIdx, allIdx + 500);
    expect(allBlock).not.toContain('excludedSettlementClause');
    // السندان المتقابلان يكتبان كما هما في rewriteSale (فئات
    // INSERT الثلاث untouched).
    expect(sale).toContain('maySettleChannels &&');
    expect(sale).toContain('تسوية قناة تعديل فاتورة');
  });
});

describe('v77 — ٤ الإصدار: 77.0.0 (86) في config والبناء', () => {
  test('config.ts وbuild.gradle عند 78.0.0 / 86', () => {
    const config = read(CONFIG);
    const gradle = read(GRADLE);
    expect(config).toContain("APP_VERSION = '78.1.0'");
    expect(config).toContain('APP_BUILD_CODE = 87');
    expect(gradle).toContain('versionName "78.1.0"');
    expect(gradle).toContain('versionCode 87');
  });
});
