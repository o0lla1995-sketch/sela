/**
 * core/paymentMethods.ts — v70 (الجولة 74 #2): نظام خيارات الدفع
 * المتعددة وتتبع الأرصدة.
 * ─────────────────────────────────────────────────────────────────
 * طرق الدفع المتاحة للتاجر الفلسطيني:
 *   • نقدي (كاش) — دائماً مفعّل، أساس الخزينة النقدية.
 *   • بنوك: بنك فلسطين، بنك القدس، البنك الإسلامي.
 *   • محافظ إلكترونية: جوال باي، بال باي، مال تشات.
 *
 * كل عملية بيع تُربط بطريقة الدفع المختارة (sales.payment_method)
 * فتُتتبع الأرصدة الواردة لكل حساب: بنكي / محفظة / خزينة نقدية.
 *
 * التصميم:
 *   • السجل مصدر الحقيقة الواحد: المعرّف، الاسم، النوع، لون العلامة،
 *     حرفا العلامة للأيقونة — كل الواجهات (الدفع، الإعدادات،
 *     التقارير، الفواتير، الإيصال) تقرأ منه.
 *   • النقدي لا يُعطَّل أبداً (لا بيع بلا طريقة دفع).
 *   • payment_method فارغ/NULL = مبيعات قديمة قبل v70 → تُعرض
 *     وتُحسب «نقدي» (توافق كامل مع التاريخ القائم).
 */

/** معرّفات ثابتة تُخزن في sales.payment_method (لا تُترجم أبداً). */
export type PaymentMethodId =
  | 'cash'
  | 'bank_palestine'
  | 'bank_quds'
  | 'bank_islami'
  | 'jawwal_pay'
  | 'palpay'
  | 'malchat';

export type PaymentMethodKind = 'cash' | 'bank' | 'wallet';

export interface PaymentMethod {
  id: PaymentMethodId;
  /** الاسم المعروض بالعربية (الإيصال، الواجهة، التقارير). */
  label: string;
  kind: PaymentMethodKind;
  /** لون العلامة التجارية (خلفية رقاقة الأيقونة). */
  color: string;
  /** حرفا العلامة داخل الأيقونة (JP، فلسطين…) — أصلية بلا شعارات محفوظة. */
  mark: string;
  /** هل يمكن تعطيلها من الإعدادات؟ (النقدي لا). */
  locked: boolean;
}

/** السجل الرسمي — الترتيب هو ترتيب الظهور في واجهة الدفع. */
export const PAYMENT_METHODS: PaymentMethod[] = [
  {
    id: 'cash',
    label: 'نقدي',
    kind: 'cash',
    color: '#16A34A',
    mark: '₪',
    locked: true,
  },
  {
    id: 'bank_palestine',
    label: 'بنك فلسطين',
    kind: 'bank',
    color: '#DC2626',
    mark: 'ف',
    locked: false,
  },
  {
    id: 'bank_quds',
    label: 'بنك القدس',
    kind: 'bank',
    color: '#0F766E',
    mark: 'ق',
    locked: false,
  },
  {
    id: 'bank_islami',
    label: 'البنك الإسلامي',
    kind: 'bank',
    color: '#B45309',
    mark: 'إ',
    locked: false,
  },
  {
    id: 'jawwal_pay',
    label: 'جوال باي',
    kind: 'wallet',
    color: '#F97316',
    mark: 'JP',
    locked: false,
  },
  {
    id: 'palpay',
    label: 'بال باي',
    kind: 'wallet',
    color: '#2563EB',
    mark: 'P',
    locked: false,
  },
  {
    id: 'malchat',
    label: 'مال تشات',
    kind: 'wallet',
    color: '#7C3AED',
    mark: 'M',
    locked: false,
  },
];

const BY_ID: Map<string, PaymentMethod> = new Map(
  PAYMENT_METHODS.map(m => [m.id, m]),
);

/** طريقة الدفع بمعرّفها — أو النقدي لأي قيمة غير معروفة/فارغة
 *  (مبيعات ما قبل v70 تُحسب نقدياً بلا ترحيل). */
export function paymentMethodById(id: string | null | undefined): PaymentMethod {
  if (id != null && id !== '') {
    const hit = BY_ID.get(id);
    if (hit != null) {
      return hit;
    }
  }
  return BY_ID.get('cash') as PaymentMethod;
}

/** التسمية الجاهزة للعرض (إيصال/فاتورة/تقرير). */
export function paymentMethodLabel(id: string | null | undefined): string {
  return paymentMethodById(id).label;
}

/** v71 (الجولة 75 #6): عرض أي معرف طريقة دفع في التقارير —
 *  المعروف يأتي من السجل، والقيم التاريخية (card/other) تعرض
 *  «بطاقة/أخرى» بلا إسقاطها على النقدي (أرصدة السدادات القديمة). */
export type DisplayMethod = Omit<PaymentMethod, 'id'> & {id: string};

export function displayMethod(id: string | null | undefined): DisplayMethod {
  if (id != null && id !== '') {
    const hit = BY_ID.get(id);
    if (hit != null) {
      return hit;
    }
    if (id === 'card') {
      return {
        id: 'card',
        label: 'بطاقة',
        kind: 'cash',
        color: '#6B7280',
        mark: 'بطاقة',
        locked: false,
      };
    }
  }
  return {
    id: 'other',
    label: 'أخرى',
    kind: 'cash',
    color: '#6B7280',
    mark: 'أخرى',
    locked: false,
  };
}

/** كل المعرّفات الصالحة (تحقق مدخلات الواجهات). */
export function isPaymentMethodId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * الطرق المتاحة للدفع وفق تفعيل التاجر: النقدي أولاً دائماً ثم
 * البنوك والمحافظ المفعّلة بترتيب السجل.
 *
 * enabledMap قد يكون جزئياً (ترقية من نسخة أقدم) — كل بنك/محفظة
 * غير مذكورة تُعد مفعّلة (قرار الإطلاق: تظهر كلها ليكتشفها التاجر
 * ثم يعطّل ما لا يملكه من الإعدادات).
 */
export function activePaymentMethods(
  enabledMap: Record<string, boolean> | null | undefined,
): PaymentMethod[] {
  return PAYMENT_METHODS.filter(m => {
    if (m.locked) {
      return true;
    }
    if (enabledMap == null) {
      return true;
    }
    const flag = enabledMap[m.id];
    return flag == null ? true : Boolean(flag);
  });
}

/** واجهة إعدادات التفعيل الافتراضية: الكل مفعّل. */
export function defaultPaymentMethodsEnabled(): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const m of PAYMENT_METHODS) {
    map[m.id] = true;
  }
  return map;
}

/** تسمية النوع (فلترة/تبويب التقارير). */
export const PAYMENT_KIND_LABELS: Record<PaymentMethodKind, string> = {
  cash: 'الخزينة النقدية',
  bank: 'حسابات بنكية',
  wallet: 'محافظ إلكترونية',
};
