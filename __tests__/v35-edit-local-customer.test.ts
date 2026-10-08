/**
 * v35 (الجولة 43) — تعديل بيانات الزبون المحلي من نافذته.
 * ─────────────────────────────────────────────────────────────────
 * طلب التاجر: «في صفحة دفتر الديون الخاصة بالزبائن المحليين لا
 * يوجد خيار تعديل بيانات الزبون في نافذة الزبون».
 *
 *  • نافذة الزبون تحمل زر تعديل يفتح نافذة بيانات كاملة (هوية،
 *    اسم، جوال) بنفس معايير التسجيل وتحقق فوري.
 *  • updateCustomer يقبل رقم الهوية الجديد — والقيد UNIQUE يمنع
 *    تكرار الهوية بين الزبائن.
 *  • الديون والسدادّات لا تتأثر بالتعديل إطلاقاً.
 */
import {freshApp, load} from './helpers/app';

const read = (path: string) =>
  require('fs').readFileSync(path, 'utf8') as string;

const SCREEN = 'src/screens/debts/LocalDebtsScreen.tsx';
const REPO = 'src/database/repositories/LocalDebtsRepo.ts';

describe('v35 — تعديل بيانات الزبون المحلي (نافذة الزبون)', () => {
  test('زر تعديل في رأس نافذة الزبون يفتح نافذة التعديل', () => {
    const src = read(SCREEN);
    // الزر في رأس النافذة.
    expect(src).toContain('styles.editHeadBtn');
    expect(src).toContain('onPress={() => openEdit(detail)}');
    // نافذة التعديل بحقول الهوية والاسم والجوال.
    expect(src).toContain('تعديل بيانات الزبون');
    expect(src).toContain('editIdFieldRef');
    expect(src).toContain('editNameFieldRef');
    expect(src).toContain('editPhoneFieldRef');
    // الحفظ بنفس معايير التسجيل + تفرد الهوية.
    expect(src).toContain('isValidIdNumber(editId)');
    expect(src).toContain('isValidLocalPhone(editPhone)');
    expect(src).toContain('LocalDebtsRepo.byIdNumber(editId.trim())');
    expect(src).toContain('رقم الهوية مسجّل لزبون آخر');
    // طمأنة التاجر تحت العنوان: السجل لا يتأثر.
    expect(src).toContain('الديون والسدادّات لا تتأثر بالتعديل');
  });

  test('المستودع: updateCustomer يقبل رقم الهوية الجديد', () => {
    const src = read(REPO);
    expect(src).toContain("sets.push('id_number = ?')");
    expect(src).toContain('idNumber?: string');
  });

  test('تكاملي: تعديل الاسم والهوية والجوال لا يمس الديون والسدادّات', async () => {
    const app = freshApp();
    await app.connection.initDatabase();
    const {LocalDebtsRepo} = load(
      'src/database/repositories/LocalDebtsRepo',
    );

    // زبون بدين 50₪ وسداد 20₪.
    const created = await LocalDebtsRepo.createCustomer({
      idNumber: '401234567',
      name: 'خالد القديم',
      phone: '0591234567',
    });
    await LocalDebtsRepo.addDebt({
      localCustomerId: created.id,
      amountMinor: 5000,
      description: 'فاتورة دين',
    });
    await LocalDebtsRepo.addPayment({
      localCustomerId: created.id,
      amountMinor: 2000,
      method: 'cash',
      note: 'سداد',
    });

    // تعديل كامل البيانات: هوية جديدة + اسم جديد + جوال جديد.
    await LocalDebtsRepo.updateCustomer(created.id, {
      idNumber: '402345678',
      name: 'خالد الجديد',
      phone: '0569876543',
    });

    const after = await LocalDebtsRepo.byIdNumber('402345678');
    expect(after).not.toBeNull();
    expect(after!.name).toBe('خالد الجديد');
    expect(after!.phone).toBe('0569876543');
    // الهوية القديمة لم يعد يحملها أحد.
    expect(await LocalDebtsRepo.byIdNumber('401234567')).toBeNull();

    // الرصيد كما كان بالضبط: 50 دين − 20 سداد = 30₪.
    const balances = await LocalDebtsRepo.listWithBalances();
    const entry = balances.find(row => row.customer.id === created.id);
    expect(entry).toBeDefined();
    expect(entry!.outstandingMinor).toBe(3000);
    expect(entry!.debtTotalMinor).toBe(5000);
    expect(entry!.paidTotalMinor).toBe(2000);

    // والسجلات نفسها سليمة.
    const debts = await LocalDebtsRepo.listDebts(created.id);
    const pays = await LocalDebtsRepo.listPayments(created.id);
    expect(debts.length).toBe(1);
    expect(pays.length).toBe(1);
  });
});
