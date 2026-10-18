/**
 * CashiersRepo — v58 (الجولة 62): حسابات الكاشيرين على الشبكة المحلية.
 * ─────────────────────────────────────────────────────────────────
 * المدير في نقطة البيع ينشئ حساباً (اسم مستخدم + كلمة مرور + اسم
 * معروض) لكل كاشير، ويقرر السماح له أو لا (is_active)، ويربط بكل
 * حساب سقف خصم خاصاً به (max_discount_pct).
 *
 * كل جهاز كاشير يتصل أول مرة يُسجَّل pending بانتظار موافقة المدير
 * («اسمح أو لا تسمح») — بعد الموافقة يُصدر له رمز جلسة (token)
 * يُقدَّم مع كل طلب لاحق. الجهاز المرفوض يبقى مرفوضاً حتى يوافق
 * المدير عليه صراحة.
 *
 * كلمات المرور تُخزَّن SHA-512 مملّحة فقط — نفس أسلوب قفل التطبيق
 * (appLockStore.hashPin)؛ لا نص صريح في القاعدة إطلاقاً.
 */
import {getDb} from '../connection';
import {localNow} from '../../core/format';
import {hashPin} from '../../stores/appLockStore';
import nacl from 'tweetnacl';

export interface CashierRecord {
  id: number;
  username: string;
  display_name: string;
  is_active: number;
  max_discount_pct: number;
  created_at: string;
  last_seen_at: string | null;
}

export interface CashierDeviceRecord {
  id: number;
  cashier_id: number;
  device_id: string;
  device_label: string;
  status: 'pending' | 'approved' | 'denied';
  token: string | null;
  ip: string | null;
  first_seen_at: string;
  last_seen_at: string | null;
}

/** ملخص نشاط الكاشير — يغذّي شاشة الإدارة وتقارير المدير. */
export interface CashierStats {
  cashierId: number;
  salesCount: number;
  salesTotal: number;
  returnsCount: number;
  returnsTotal: number;
  netTotal: number;
}

/** عشوائية آمنة داخل RN: إنتروبيا الوقت + Math.random تُمرَّر عبر
 *  SHA-512 — nacl.randomBytes يرمي في RN (بلا PRNG) وهذا البديل
 *  المستقر المعتمد في appLockStore. للرموز المحلية على الشبكة
 *  المحلية يُعد كافياً تماماً (128 حرفاً سداسياً = 64 بايت). */
function randomHex(): string {
  let hex = '';
  for (const b of nacl.hash(
    new Uint8Array(
      `${Date.now()}:${Math.random()}:${Math.random()}`.split('').map(
        c => c.charCodeAt(0),
      ),
    ),
  )) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

function toBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i);
  }
  return out;
}

/** SHA-512 سداسي عشري لنص (للرموز والمفاتيح الثانوية). */
function shaHex(text: string): string {
  let hex = '';
  for (const b of nacl.hash(toBytes(text))) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

function rowToCashier(row: Record<string, unknown>): CashierRecord {
  return {
    id: Number(row.id),
    username: String(row.username ?? ''),
    display_name: String(row.display_name ?? ''),
    is_active: Number(row.is_active ?? 1),
    max_discount_pct: Number(row.max_discount_pct ?? 10),
    created_at: String(row.created_at ?? ''),
    last_seen_at: row.last_seen_at ? String(row.last_seen_at) : null,
  };
}

function rowToDevice(row: Record<string, unknown>): CashierDeviceRecord {
  return {
    id: Number(row.id),
    cashier_id: Number(row.cashier_id),
    device_id: String(row.device_id ?? ''),
    device_label: String(row.device_label ?? ''),
    status: (row.status as CashierDeviceRecord['status']) ?? 'pending',
    token: row.token ? String(row.token) : null,
    ip: row.ip ? String(row.ip) : null,
    first_seen_at: String(row.first_seen_at ?? ''),
    last_seen_at: row.last_seen_at ? String(row.last_seen_at) : null,
  };
}

export const CashiersRepo = {
  /** إنشاء حساب كاشير — كلمة المرور تُخزَّن مملّحة. */
  async createCashier(input: {
    username: string;
    password: string;
    displayName: string;
    maxDiscountPct?: number;
  }): Promise<number> {
    const username = input.username.trim().toLowerCase();
    if (!username) {
      throw new Error('اسم المستخدم مطلوب');
    }
    if (input.password.length < 4) {
      throw new Error('كلمة المرور 4 أحرف على الأقل');
    }
    const salt = shaHex(`${username}:${Date.now()}:${Math.random()}`);
    const result = await getDb().execute(
      `INSERT INTO lan_cashiers
        (username, password_hash, salt, display_name, is_active, max_discount_pct, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [
        username,
        hashPin(input.password, salt),
        salt,
        input.displayName.trim() || username,
        Math.max(0, Math.min(95, Number(input.maxDiscountPct ?? 10))),
        localNow(),
      ],
    );
    return result.insertId ?? -1;
  },

  /** تعديل حساب: الاسم المعروض والسماح وسقف الخصم، وكلمة المرور
   *  اختيارياً (تُستبدل بملح جديد). */
  async updateCashier(
    id: number,
    patch: {
      displayName?: string;
      isActive?: number;
      maxDiscountPct?: number;
      password?: string;
    },
  ): Promise<void> {
    const db = getDb();
    if (patch.displayName != null) {
      await db.execute(
        'UPDATE lan_cashiers SET display_name = ? WHERE id = ?',
        [patch.displayName.trim(), id],
      );
    }
    if (patch.isActive != null) {
      await db.execute(
        'UPDATE lan_cashiers SET is_active = ? WHERE id = ?',
        [patch.isActive === 1 ? 1 : 0, id],
      );
      // منع الكاشير يقطع جلساته فوراً: رموز أجهزته تُبطل.
      if (patch.isActive !== 1) {
        await db.execute(
          'UPDATE lan_devices SET token = NULL WHERE cashier_id = ?',
          [id],
        );
      }
    }
    if (patch.maxDiscountPct != null) {
      await db.execute(
        'UPDATE lan_cashiers SET max_discount_pct = ? WHERE id = ?',
        [Math.max(0, Math.min(95, Number(patch.maxDiscountPct))), id],
      );
    }
    if (patch.password != null && patch.password.length >= 4) {
      const salt = shaHex(`${id}:${Date.now()}:${Math.random()}`);
      await db.execute(
        'UPDATE lan_cashiers SET password_hash = ?, salt = ? WHERE id = ?',
        [hashPin(patch.password, salt), salt, id],
      );
      // كلمة المرور تغيّرت — تُبطل الجلسات القائمة احتياطاً.
      await db.execute(
        'UPDATE lan_devices SET token = NULL WHERE cashier_id = ?',
        [id],
      );
    }
  },

  async removeCashier(id: number): Promise<void> {
    await getDb().execute('DELETE FROM lan_cashiers WHERE id = ?', [id]);
  },

  async list(): Promise<CashierRecord[]> {
    const result = await getDb().execute(
      'SELECT * FROM lan_cashiers ORDER BY display_name COLLATE NOCASE',
    );
    return ((result.rows ?? []) as Record<string, unknown>[]).map(
      rowToCashier,
    );
  },

  async byId(id: number): Promise<CashierRecord | null> {
    const result = await getDb().execute(
      'SELECT * FROM lan_cashiers WHERE id = ?',
      [id],
    );
    const rows = (result.rows ?? []) as Record<string, unknown>[];
    return rows.length > 0 ? rowToCashier(rows[0]) : null;
  },

  /** التحقق من اسم المستخدم وكلمة المرور (بدون لمس الجلسات).
   *  يعيد السجل عند النجاح أو null. */
  async authenticate(
    username: string,
    password: string,
  ): Promise<CashierRecord | null> {
    const result = await getDb().execute(
      'SELECT * FROM lan_cashiers WHERE username = ?',
      [username.trim().toLowerCase()],
    );
    const rows = (result.rows ?? []) as Record<string, unknown>[];
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0];
    const salt = String(row.salt ?? '');
    const expected = String(row.password_hash ?? '');
    if (!salt || !expected) {
      return null;
    }
    if (hashPin(password, salt) !== expected) {
      return null;
    }
    return rowToCashier(row);
  },

  /** جلب أو إنشاء سجل الجهاز لأول اتصال — يبقى pending إن كان
   *  جديداً بانتظار موافقة المدير. */
  async findOrCreateDevice(
    cashierId: number,
    deviceId: string,
    deviceLabel: string,
    ip: string | null,
  ): Promise<CashierDeviceRecord> {
    const db = getDb();
    const found = await db.execute(
      'SELECT * FROM lan_devices WHERE cashier_id = ? AND device_id = ?',
      [cashierId, deviceId],
    );
    const foundRows = (found.rows ?? []) as Record<string, unknown>[];
    if (foundRows.length > 0) {
      await db.execute(
        'UPDATE lan_devices SET ip = ?, device_label = ? WHERE id = ?',
        [ip, deviceLabel, Number(foundRows[0].id)],
      );
      const refreshed = await db.execute(
        'SELECT * FROM lan_devices WHERE id = ?',
        [Number(foundRows[0].id)],
      );
      const rows = (refreshed.rows ?? []) as Record<string, unknown>[];
      return rowToDevice(rows[0]);
    }
    await db.execute(
      `INSERT INTO lan_devices
        (cashier_id, device_id, device_label, status, ip, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      [cashierId, deviceId, deviceLabel, ip, localNow(), localNow()],
    );
    const created = await db.execute(
      'SELECT * FROM lan_devices WHERE cashier_id = ? AND device_id = ?',
      [cashierId, deviceId],
    );
    const rows = (created.rows ?? []) as Record<string, unknown>[];
    return rowToDevice(rows[0]);
  },

  /** موافقة المدير على جهاز — يُصدر رمز جلسة جديداً. */
  async approveDevice(deviceId: number): Promise<void> {
    await getDb().execute(
      `UPDATE lan_devices
       SET status = 'approved', token = ?, last_seen_at = ?
       WHERE id = ?`,
      [randomHex(), localNow(), deviceId],
    );
  },

  /** رفض الجهاز — يبقى مرفوضاً ويُبطل رمزه. */
  async denyDevice(deviceId: number): Promise<void> {
    await getDb().execute(
      `UPDATE lan_devices SET status = 'denied', token = NULL WHERE id = ?`,
      [deviceId],
    );
  },

  /** إلغاء ثقة جهاز موافق عليه (قطع الاتصال وإعادة تعليقه). */
  async revokeDevice(deviceId: number): Promise<void> {
    await getDb().execute(
      `UPDATE lan_devices SET status = 'pending', token = NULL WHERE id = ?`,
      [deviceId],
    );
  },

  /** تسجيل خروج: يُبطل رمز الجهاز (يبقى معتمداً — الدخول القادم
   *  يصدر رمزاً جديداً بلا انتظار موافقة). */
  async clearToken(deviceId: number): Promise<void> {
    await getDb().execute(
      'UPDATE lan_devices SET token = NULL WHERE id = ?',
      [deviceId],
    );
  },

  /** المصادقة المستمرة: كل طلب من تطبيق الكاشير يحمل رمز الجلسة —
   *  يعيد الكاشير والجهاز معاً أو null. */
  async byToken(
    token: string,
  ): Promise<{cashier: CashierRecord; device: CashierDeviceRecord} | null> {
    if (!token || token.length < 16) {
      return null;
    }
    const result = await getDb().execute(
      `SELECT d.id AS device_row_id, d.*, c.id AS cashier_id_1
       FROM lan_devices d
       JOIN lan_cashiers c ON c.id = d.cashier_id
       WHERE d.token = ?`,
      [token],
    );
    const rows = (result.rows ?? []) as Record<string, unknown>[];
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0];
    if (String(row.status ?? '') !== 'approved') {
      return null;
    }
    const cashier = await this.byId(Number(row.cashier_id));
    if (!cashier || cashier.is_active !== 1) {
      return null;
    }
    const device: CashierDeviceRecord = {
      id: Number(row.device_row_id ?? row.id),
      cashier_id: Number(row.cashier_id),
      device_id: String(row.device_id ?? ''),
      device_label: String(row.device_label ?? ''),
      status: 'approved',
      token,
      ip: row.ip ? String(row.ip) : null,
      first_seen_at: String(row.first_seen_at ?? ''),
      last_seen_at: row.last_seen_at ? String(row.last_seen_at) : null,
    };
    return {cashier, device};
  },

  /** لمس آخر ظهور للجهاز (لعرض «متصل الآن»). */
  async touchDevice(deviceId: number): Promise<void> {
    await getDb().execute(
      'UPDATE lan_devices SET last_seen_at = ? WHERE id = ?',
      [localNow(), deviceId],
    );
  },

  async touchCashier(cashierId: number): Promise<void> {
    await getDb().execute(
      'UPDATE lan_cashiers SET last_seen_at = ? WHERE id = ?',
      [localNow(), cashierId],
    );
  },

  async devicesFor(cashierId: number): Promise<CashierDeviceRecord[]> {
    const result = await getDb().execute(
      'SELECT * FROM lan_devices WHERE cashier_id = ? ORDER BY id DESC',
      [cashierId],
    );
    return ((result.rows ?? []) as Record<string, unknown>[]).map(
      rowToDevice,
    );
  },

  async pendingDevices(): Promise<CashierDeviceRecord[]> {
    const result = await getDb().execute(
      `SELECT d.* FROM lan_devices d
       JOIN lan_cashiers c ON c.id = d.cashier_id
       WHERE d.status = 'pending' AND c.is_active = 1
       ORDER BY d.id DESC`,
    );
    return ((result.rows ?? []) as Record<string, unknown>[]).map(
      rowToDevice,
    );
  },

  /** إحصاءات كاشير: مبيعاته ومرتجعاته (صفوف RET السالبة) —
   *  فواتير نقطة البيع (cashier_id NULL) لا تدخل هنا أبداً. */
  async statsFor(cashierId: number): Promise<CashierStats> {
    const db = getDb();
    const sales = await db.execute(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount), 0) AS total
       FROM sales
       WHERE cashier_id = ? AND invoice_number NOT LIKE 'RET-%'`,
      [cashierId],
    );
    const returns = await db.execute(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount), 0) AS total
       FROM sales
       WHERE cashier_id = ? AND invoice_number LIKE 'RET-%'`,
      [cashierId],
    );
    const salesRow = ((sales.rows ?? []) as Record<string, unknown>[])[0] ?? {};
    const returnsRow =
      ((returns.rows ?? []) as Record<string, unknown>[])[0] ?? {};
    const salesTotal = Number(salesRow.total ?? 0);
    const returnsTotal = Number(returnsRow.total ?? 0);
    return {
      cashierId,
      salesCount: Number(salesRow.cnt ?? 0),
      salesTotal,
      returnsCount: Number(returnsRow.cnt ?? 0),
      returnsTotal,
      netTotal: salesTotal + returnsTotal,
    };
  },
};
