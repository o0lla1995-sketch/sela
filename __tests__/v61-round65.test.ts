/**
 * v61 — الجولة 65: حرّوس إصلاح إرجاع/استبدال فواتير الكاشير.
 * ─────────────────────────────────────────────────────────────────
 * الجذر المكتشف من ملاحظات التاجر على تطبيق الكاشير: «الفواتير التي
 * يمكن الاستبدال فيها أو الإرجاع — لا يسمح بالاستبدال أو الإرجاع
 * والعملية غير منتظمة». السبب الحقيقي في الخادم: تطبيق الكاشير يرسل
 * معرّف صنف أرشيفه المحلي (SQLite خاص به) في خانة saleItemId —
 * فضاء معرّفات مختلف كلياً عن sale_items عندنا — فيرد الخادم
 * «صنف غير موجود في الفاتورة» شبه دائماً.
 *
 * الإصلاح (handleReturn):
 *  ① saleItemId الصحيح يُقبل إن تطابق منتجُه (حماية تصادمات).
 *  ② مطابقة احتياطية بالتوقيع الكامل: productId + variantLabel
 *     + unitName (تطبيع وحدة القاعدة: حبة/قطعة/فارغ واحد).
 *  ③ الدفع دائماً بالمعرّف المحسوم known.item.id لا معرّف العميل.
 */
const read = (p: string) => require('fs').readFileSync(p, 'utf8') as string;

describe('v61 — الجولة 65: حل أسطر الإرجاع عند الخادم', () => {
  test('① معرّف العميل يُتحقق من تصادمه قبل قبوله', () => {
    const src = read('src/services/lan/LanHandlers.ts');
    // لا يُقبل saleItemId إلا بتطابق منتجِه — وإلا نكمل بالتوقيع.
    expect(src).toContain(
      'known != null && lineProductId > 0 && known.item.product_id !== lineProductId',
    );
    expect(src).toContain('معرّف متصادم من أرشيف محلي');
  });

  test('② المطابقة الاحتياطية بالتوقيع الكامل (منتج + متغير + وحدة)', () => {
    const src = read('src/services/lan/LanHandlers.ts');
    expect(src).toContain('const lineProductId = Number(line.productId ?? 0)');
    expect(src).toContain('const lineVariantLabel =');
    expect(src).toContain('const lineUnitName =');
    // تطبيع وحدة القاعدة: حبة (كاشير) = قطعة (خادم) = فارغ.
    expect(src).toContain("v === 'حبة' || v === 'قطعة'");
    expect(src).toContain('normUnit(l.item.unit_name ?? null) === normUnit(lineUnitName)');
    // الأفضلية لسطر ما زال له متبقٍ.
    expect(src).toContain('candidates.find(l => l.remaining > 0.0001)');
  });

  test('③ الدفع بالمعرّف المحسوم known.item.id لا معرّف العميل', () => {
    const src = read('src/services/lan/LanHandlers.ts');
    expect(src).toContain('saleItemId: known.item.id');
  });

  test('④ سقف الخصم ما زال مفروضاً عند الخادم (لا تراجع)', () => {
    const src = read('src/services/lan/LanHandlers.ts');
    expect(src).toContain(
      'const maxDiscount = (subtotal * authed.maxDiscountPct) / 100',
    );
    expect(src).toContain('const discount = Math.min(requested, maxDiscount)');
  });

  test('⑤ الإصدار: 64.0.0 (72)', () => {
    const config = read('src/core/config.ts');
    expect(config).toContain("APP_VERSION = '64.0.0'");
    expect(config).toContain('APP_BUILD_CODE = 72');
  });
});
