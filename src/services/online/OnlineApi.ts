/**
 * OnlineApi — v48 (الجولة 56): عميل واجهات التاجر على خادم سيلا.
 * ─────────────────────────────────────────────────────────────────
 * نفس خادم التراخيص (LICENSE_SERVER_URL المعتمد من الإدارة) ونفس
 * زوج المصادقة الصامت (license + signature + deviceId) المستخدم في
 * نبضة الترخيص — التاجر لا يدخل أي بيانات إضافية.
 */
import {
  getServerUrl,
  loadLicense,
  getDeviceId,
} from '../license/LicenseService';
import {logDiag} from '../../core/diagnostics';

export type OnlineApiErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'NOT_ACTIVATED'
  | 'SUBSCRIPTION_ENDED'
  | 'STORE_NOT_REGISTERED'
  | 'ORDER_NOT_FOUND'
  | 'BAD_STATUS'
  | 'BAD_ACTION'
  | 'BAD_RETURN_VALUE'
  | 'SERVER_ERROR'
  | (string & {});

export class OnlineApiError extends Error {
  constructor(
    message: string,
    readonly code: OnlineApiErrorCode,
  ) {
    super(message);
  }
}

/** أخطاء الخادم بلغة التاجر. */
export function onlineApiErrorText(code: string): string {
  switch (code) {
    case 'SUBSCRIPTION_ENDED':
      return 'انتهى اشتراك سيلا — جدّده لدى الإدارة ثم أعد تفعيل البيع أونلاين';
    case 'STORE_NOT_REGISTERED':
      return 'متجرك غير مسجل على الخادم — فعّل البيع أونلاين من الإعدادات أولاً';
    case 'ORDER_NOT_FOUND':
      return 'الطلب غير موجود على الخادم';
    case 'BAD_STATUS':
      return 'حالة الطلب تغيّرت على الخادم — حدّث القائمة وحاول مجدداً';
    case 'BAD_ACTION':
      return 'إجراء غير مسموح في هذه الحالة';
    case 'BAD_RETURN_VALUE':
      return 'قيمة الإرجاع أكبر من المتبقي القابل للإرجاع';
    default:
      return 'تعذر الاتصال بخادم البيع أونلاين — تحقق من الإنترنت وحاول مجدداً';
  }
}

async function storePost<T>(
  path: string,
  body: Record<string, unknown>,
  timeoutMs = 20000,
): Promise<T> {
  const current = loadLicense();
  if (current == null) {
    throw new OnlineApiError(
      'التطبيق غير مفعّل — فعّل اشتراكك أولاً',
      'NOT_ACTIVATED',
    );
  }
  const deviceId = await getDeviceId();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${getServerUrl()}${path}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        license: current.payloadB64,
        signature: current.signatureB64,
        deviceId,
        ...body,
      }),
      signal: controller.signal,
    });
    const data = (await response.json().catch(() => null)) as
      | (T & {ok?: boolean; error?: string})
      | null;
    if (!response.ok || data?.ok !== true) {
      const code = data?.error ?? `HTTP_${response.status}`;
      throw new OnlineApiError(onlineApiErrorText(code), code);
    }
    return data as T;
  } catch (error) {
    if (error instanceof OnlineApiError) {
      throw error;
    }
    const aborted = error instanceof Error && error.name === 'AbortError';
    logDiag(
      'online',
      `فشل نداء ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'warn',
    );
    throw new OnlineApiError(
      aborted
        ? 'انتهت مهلة الاتصال بالخادم — حاول مجدداً'
        : onlineApiErrorText('NETWORK'),
      aborted ? 'TIMEOUT' : 'NETWORK',
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface OnlineStoreProfile {
  name: string;
  description: string;
  category: string;
  region: string;
  phone: string;
  whatsapp: string;
}

export const OnlineApi = {
  /** إنشاء/تحديث ملف المتجر + مناطق التوصيل. */
  async register(input: {
    store: OnlineStoreProfile;
    deliveryRegions: {name: string; feeMinor: number}[];
    published: boolean;
  }): Promise<{storeNumber: string; published: boolean; serverTime: number}> {
    const data = await storePost<{
      store: {storeNumber: string; published: boolean};
      serverTime: number;
    }>('/api/v1/store/register', {
      store: input.store,
      deliveryRegions: input.deliveryRegions,
      published: input.published,
    });
    return {
      storeNumber: data.store.storeNumber,
      published: data.store.published,
      serverTime: data.serverTime,
    };
  },

  /** مزامنة الكتالوج الكامل (idempotent بـ product_ref). */
  async syncProducts(
    products: {
      ref: string;
      name: string;
      category: string;
      priceMinor: number;
      stock: number;
      barcode?: string;
      soldByWeight?: boolean;
      unitLabel?: string;
    }[],
  ): Promise<{saved: number; serverTime: number}> {
    const data = await storePost<{saved: number; serverTime: number}>(
      '/api/v1/store/products/sync',
      {products},
      45000,
    );
    return data;
  },

  /** استطلاع الطلبات المحدثة منذ مؤشر. */
  async poll(
    since: number,
  ): Promise<{orders: unknown[]; serverTime: number}> {
    return storePost<{orders: unknown[]; serverTime: number}>(
      '/api/v1/store/orders/poll',
      {since},
      15000,
    );
  },

  /** فعل على طلب (قبول/رفض/إرسال/تسليم/إلغاء/إرجاع). */
  async action(input: {
    orderNumber: string;
    action: 'accept' | 'reject' | 'send' | 'deliver' | 'cancel' | 'return';
    reason?: string;
    invoiceRef?: string;
    returnedMinor?: number;
  }): Promise<{order: {order_number: string; status: string; revision: number}; serverTime: number}> {
    const data = await storePost<{
      order: {order_number: string; status: string; revision: number};
      serverTime: number;
    }>('/api/v1/store/orders/action', input as Record<string, unknown>);
    return data;
  },
};
