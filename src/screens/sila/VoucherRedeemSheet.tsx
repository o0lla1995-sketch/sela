/**
 * v20 — VoucherRedeemSheet: the shared «صرف قسيمة صلة» overlay
 * (SILA_POS_VOUCHERS_API §7.1).
 * ─────────────────────────────────────────────────────────────────
 * An INLINE absolute overlay — NEVER a RN Modal (this ROM blacks
 * Modals right after the native scanner closes; the same lesson as
 * the POS debt sheet). Two entry contexts share it:
 *   • POS checkout (cart-tied): the cart's goods become the INV-V
 *     sale — stock decrements + revenue; the difference rules apply
 *     (cart > voucher → cash at counter / cart < voucher → surplus
 *     claimed within the settlement).
 *   • Sila screen (standalone): pure redemption (parcel campaigns /
 *     untracked goods) — no sale row, the claim mirrors from the
 *     server answer.
 *
 * State machine: input → calling → success | failed (permanent) |
 * pending (transient — the engine completes it and notifies).
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {Icon} from '../../components/Icon';
import {AppButton} from '../../components/ui';
import {
  fonts,
  radius,
  spacing,
  typography,
  useThemeColors,
} from '../../core/theme';
import {formatMoney} from '../../core/format';
import {useToastStore} from '../../stores/toastStore';
import {useSilaStore} from '../../stores/silaStore';
import {scanBarcode} from '../../services/vision/scanFlow';
import {parseSilaVoucherCode} from '../../services/sila/qr';
import {
  VoucherService,
  VoucherRedeemError,
  type VoucherRedeemSuccess,
} from '../../services/VoucherService';
import type {CartLine, PricingMode} from '../../core/types';
import type {ReceiptSettings} from '../../services/printer/receipt';

export interface VoucherCartContext {
  lines: CartLine[];
  discount: number;
  pricingMode: PricingMode;
  /** Cart total in ₪ (lines − discount), for the summary row. */
  total: number;
  itemsCount: number;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** The POS cart when redeeming from checkout (null = standalone). */
  cart: VoucherCartContext | null;
  receiptSettings: ReceiptSettings;
  printerConnected: boolean;
  /** Fired once on success (the POS clears its cart here). */
  onRedeemed?: (success: VoucherRedeemSuccess) => void;
}

type Step =
  | {phase: 'input'}
  | {phase: 'calling'; payload: string}
  | {phase: 'success'; data: VoucherRedeemSuccess}
  | {
      phase: 'error';
      message: string;
      pendingRetry: boolean;
      permanent: boolean;
    };

export function VoucherRedeemSheet({
  visible,
  onClose,
  cart,
  receiptSettings,
  printerConnected,
  onRedeemed,
}: Props) {
  const c = useThemeColors();
  const toast = useToastStore(state => state.show);
  const pairing = useSilaStore(state => state.pairing);

  const [step, setStep] = useState<Step>({phase: 'input'});
  const [manualCode, setManualCode] = useState('');
  const [scanBusy, setScanBusy] = useState(false);

  // Hardware back closes the sheet (except mid-call).
  useEffect(() => {
    if (!visible) {
      return;
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step.phase !== 'calling') {
        onClose();
      }
      return true;
    });
    return () => sub.remove();
  }, [visible, step.phase, onClose]);

  // Reset when reopened.
  useEffect(() => {
    if (visible) {
      setStep({phase: 'input'});
      setManualCode('');
      setScanBusy(false);
    }
  }, [visible]);

  const startRedeem = useCallback(
    async (payload: string) => {
      if (pairing == null) {
        setStep({
          phase: 'error',
          message:
            'الجهاز غير مرتبط بصِلة — اربط حساب التاجر أولاً من صفحة صِلة',
          pendingRetry: false,
          permanent: true,
        });
        return;
      }
      setStep({phase: 'calling', payload});
      try {
        const success = await VoucherService.redeemVoucher({
          payload,
          cart: cart
            ? {
                lines: cart.lines,
                discount: cart.discount,
                pricingMode: cart.pricingMode,
              }
            : null,
          print: printerConnected,
          receiptSettings,
          onPrintError: message =>
            toast(`تم الصرف لكن الطباعة فشلت: ${message}`, 'error'),
        });
        setStep({phase: 'success', data: success});
        onRedeemed?.(success);
      } catch (error) {
        if (error instanceof VoucherRedeemError) {
          setStep({
            phase: 'error',
            message: error.message,
            pendingRetry: error.pendingRetry,
            permanent: error.permanent,
          });
        } else {
          const message =
            error instanceof Error ? error.message : 'تعذر صرف القسيمة';
          setStep({
            phase: 'error',
            message,
            pendingRetry: false,
            permanent: true,
          });
        }
      }
    },
    [pairing, cart, printerConnected, receiptSettings, toast, onRedeemed],
  );

  const runScan = useCallback(async () => {
    if (scanBusy || step.phase === 'calling') {
      return;
    }
    setScanBusy(true);
    try {
      const code = await scanBarcode();
      if (code == null) {
        return; // merchant closed the scanner — nothing happened.
      }
      const parsed = parseSilaVoucherCode(code);
      if (!parsed.valid) {
        toast(parsed.reason ?? 'رمز غير سليم', 'error');
        return;
      }
      await startRedeem(parsed.payload);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'فشل مسح رمز القسيمة';
      toast(message, 'error');
    } finally {
      setScanBusy(false);
    }
  }, [scanBusy, step.phase, startRedeem, toast]);

  const submitManual = useCallback(() => {
    Keyboard.dismiss();
    const parsed = parseSilaVoucherCode(manualCode);
    if (!parsed.valid) {
      toast(parsed.reason ?? 'الكود غير سليم', 'error');
      return;
    }
    void startRedeem(parsed.payload);
  }, [manualCode, startRedeem, toast]);

  const reprint = useCallback(async () => {
    if (step.phase !== 'success') {
      return;
    }
    try {
      await VoucherService.reprintByReceiptRef(
        step.data.receiptRef,
        receiptSettings,
      );
      toast('أُرسل إيصال الصرف للطابعة', 'success');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'تعذر إعادة الطباعة';
      toast(message, 'error');
    }
  }, [step, receiptSettings, toast]);

  if (!visible) {
    return null;
  }

  const cartMinor = cart != null ? Math.round(cart.total * 100) : null;

  return (
    <View style={styles.overlay}>
      <TouchableOpacity
        style={styles.dim}
        activeOpacity={1}
        onPress={() => {
          if (step.phase !== 'calling') {
            onClose();
          }
        }}
      />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.titleRow}>
          <View style={styles.titleIcon}>
            <Icon name="ticket" size={22} color={c.accent} />
          </View>
          <Text style={styles.title}>صرف قسيمة صِلة</Text>
        </View>

        {/* ── The golden rule, always visible (§2 rule 5) ── */}
        <View style={styles.ruleBox}>
          <Icon name="info" size={15} color={c.info} />
          <Text style={styles.ruleText}>
            القسيمة حقٌّ مؤمَّن من المؤسسة — ليست ديناً على الزبون، ولا تظهر في
            كشف حسابه
          </Text>
        </View>

        {/* ── Cart summary (checkout context) ── */}
        {cart != null && step.phase === 'input' ? (
          <View style={styles.cartBox}>
            <View style={styles.cartRow}>
              <Text style={styles.cartLabel}>بضاعة السلة</Text>
              <Text style={styles.cartValue}>
                {cart.itemsCount} قطعة — {formatMoney(cart.total)}
              </Text>
            </View>
            <Text style={styles.cartRule}>
              شرط الصرف: قيمة السلة يجب أن تساوي قيمة القسيمة بالضبط
            </Text>
            <Text style={styles.cartHint}>
              تُخصم الكميات من المخزون بعد نجاح الصرف — لا قبل ذلك
            </Text>
          </View>
        ) : null}

        {/* ── Standalone note (no cart): a redemption commits the
            campaign to this store's books (round-27 #1) ── */}
        {cart == null && step.phase === 'input' ? (
          <View style={styles.standaloneBox}>
            <Icon name="info" size={14} color={c.info} />
            <Text style={styles.standaloneText}>
              الصرف المباشر (بدون سلة) مخصص لحملات الطرود والبضاعة غير
              المسعّرة — إذا كانت الحملة غير مفعّلة في متجرك فسيُفعّلها هذا
              الصرف تلقائياً لأنه التزام محسوب عليك في صِلة
            </Text>
          </View>
        ) : null}

        {/* ── INPUT ── */}
        {step.phase === 'input' ? (
          <>
            <TouchableOpacity
              style={styles.scanBtn}
              onPress={() => void runScan()}
              disabled={scanBusy}
              activeOpacity={0.85}>
              {scanBusy ? (
                <ActivityIndicator size="small" color={c.onAccent} />
              ) : (
                <Icon name="qrFrame" size={26} color={c.onAccent} />
              )}
              <View style={{flex: 1}}>
                <Text style={styles.scanBtnTitle}>مسح رمز القسيمة (QR)</Text>
                <Text style={styles.scanBtnText}>
                  من تطبيق صِلة على هاتف المستحق أو الورقة المطبوعة
                </Text>
              </View>
            </TouchableOpacity>

            <View style={styles.orRow}>
              <View style={styles.orLine} />
              <Text style={styles.orText}>أو إدخال الكود يدوياً</Text>
              <View style={styles.orLine} />
            </View>

            <View style={styles.fieldWrap}>
              <Text style={styles.fieldLabel}>كود القسيمة (20 محرفاً)</Text>
              <TextInput
                style={styles.fieldInput}
                value={manualCode}
                onChangeText={text =>
                  setManualCode(text.toUpperCase().replace(/\s+/g, ''))
                }
                placeholder="ABCD2345EFGH6789JKLM"
                placeholderTextColor={c.textFaint}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={20}
                textAlign="center"
                returnKeyType="done"
                onSubmitEditing={submitManual}
              />
              <Text style={styles.fieldHint}>
                يظهر للمستحق في تطبيق صِلة كمصروف أو على القسيمة الورقية
              </Text>
            </View>

            <AppButton
              title="صرف القسيمة"
              variant="primary"
              onPress={submitManual}
              disabled={manualCode.trim().length === 0}
            />
          </>
        ) : null}

        {/* ── CALLING (live, needs internet) ── */}
        {step.phase === 'calling' ? (
          <View style={styles.stateBox}>
            <ActivityIndicator size="large" color={c.accent} />
            <Text style={styles.stateTitle}>جارٍ الصرف عبر صِلة…</Text>
            <Text style={styles.stateText}>
              الصرف يتطلب اتصالاً حياً — لا تُسلَّم البضاعة قبل ظهور النتيجة
            </Text>
          </View>
        ) : null}

        {/* ── SUCCESS ── */}
        {step.phase === 'success' ? (
          <View style={styles.stateBox}>
            <View style={[styles.stateIcon, {backgroundColor: c.successSoft}]}>
              <Icon name="checkCircle" size={34} color={c.success} />
            </View>
            <Text style={[styles.stateTitle, {color: c.success}]}>
              صُرفت القسيمة — {formatMoney(step.data.result.value_minor / 100)}
            </Text>
            <Text style={styles.stateText}>
              حملة «{step.data.result.campaign_name}» · المرجع الرسمي{' '}
              {step.data.result.reference_code}
            </Text>
            {step.data.result.beneficiary_last4 ? (
              <Text style={styles.stateMeta}>
                هوية المستحق: ****{step.data.result.beneficiary_last4}
              </Text>
            ) : null}

            {/* v21 (round-27 #2): the EXACT-MATCH rule. The voucher's
                value is only known AFTER the server answers (the code
                carries no amount), so the enforcement lands here: a
                cart that does not equal the voucher EXACTLY is shown
                as a bold warning and the cashier must ACKNOWLEDGE the
                difference before the goods are handed over — a clean
                match gets the plain «تم» button. */}
            {cartMinor != null ? (
              cartMinor === step.data.result.value_minor ? (
                <View style={styles.matchBox}>
                  <Icon name="checkCircle" size={15} color={c.success} />
                  <Text style={styles.matchText}>
                    قيمة السلة تساوي قيمة القسيمة بالضبط — صرف سليم
                  </Text>
                </View>
              ) : (
                <View style={styles.mismatchBox}>
                  <Icon name="alert" size={16} color={c.warning} />
                  <Text style={styles.mismatchTitle}>
                    تنبيه: قيمة السلة لا تساوي قيمة القسيمة بالضبط
                  </Text>
                  <Text style={styles.mismatchText}>
                    {step.data.counterExtraMinor > 0
                      ? `قيمة السلة أكبر من القسيمة بمقدار ${formatMoney(
                          step.data.counterExtraMinor / 100,
                        )} — يجب استلام هذا الفرق نقداً من المستحق قبل تسليم البضاعة`
                      : `قيمة القسيمة أكبر من السلة بمقدار ${formatMoney(
                          step.data.surplusMinor / 100,
                        )} — سيُضاف هذا الفرق إلى مطالبتك على المؤسسة ضمن تسوية الحملة`}
                  </Text>
                </View>
              )
            ) : null}

            {/* The decomposition (requirement: clear split) */}
            {cartMinor != null ? (
              <View style={styles.decompBox}>
                <View style={styles.decompRow}>
                  <Text style={styles.decompLabel}>قيمة البضاعة (السلة)</Text>
                  <Text style={styles.decompValue}>
                    {formatMoney((cartMinor ?? 0) / 100)}
                  </Text>
                </View>
                {step.data.counterExtraMinor > 0 ? (
                  <View style={styles.decompRow}>
                    <Text style={[styles.decompLabel, {color: c.warning}]}>
                      الفرق نقداً عند الكاشير
                    </Text>
                    <Text style={[styles.decompValue, {color: c.warning}]}>
                      {formatMoney(step.data.counterExtraMinor / 100)}
                    </Text>
                  </View>
                ) : null}
                {step.data.surplusMinor > 0 ? (
                  <View style={styles.decompRow}>
                    <Text style={[styles.decompLabel, {color: c.info}]}>
                      فرق القسيمة (ضمن تسوية الحملة)
                    </Text>
                    <Text style={[styles.decompValue, {color: c.info}]}>
                      {formatMoney(step.data.surplusMinor / 100)}
                    </Text>
                  </View>
                ) : null}
                <View style={[styles.decompRow, styles.decompRowTotal]}>
                  <Text style={styles.decompLabelTotal}>قيمة القسيمة</Text>
                  <Text style={styles.decompValueTotal}>
                    {formatMoney(step.data.result.value_minor / 100)}
                  </Text>
                </View>
              </View>
            ) : null}

            <Text style={styles.stateMeta}>
              الإيصال: {step.data.receiptRef} — سُجّلت مطالبتك على المؤسسة في
              دفتر الحملات
            </Text>

            <View style={styles.actionsRow}>
              <AppButton
                title="طباعة الإيصال"
                variant="secondary"
                onPress={() => void reprint()}
                disabled={!printerConnected}
                style={{flex: 1}}
              />
              {/* v21 (round-27 #2): the closing button SPELLS OUT the
                  acknowledged difference — the cashier can't hand the
                  goods over without reading it. */}
              <AppButton
                title={
                  cartMinor != null &&
                  cartMinor !== step.data.result.value_minor
                    ? step.data.counterExtraMinor > 0
                      ? 'استلمت الفرق نقداً — تسليم البضاعة'
                      : 'إتمام — الفرق ضمن مطالبة المؤسسة'
                    : 'تم — تسليم البضاعة'
                }
                variant={
                  cartMinor != null &&
                  cartMinor !== step.data.result.value_minor
                    ? 'primary'
                    : 'success'
                }
                onPress={onClose}
                style={{flex: 1}}
              />
            </View>
          </View>
        ) : null}

        {/* ── ERROR / PENDING ── */}
        {step.phase === 'error' ? (
          <View style={styles.stateBox}>
            <View
              style={[
                styles.stateIcon,
                {
                  backgroundColor: step.pendingRetry
                    ? c.warningSoft
                    : c.dangerSoft,
                },
              ]}>
              <Icon
                name={step.pendingRetry ? 'clock' : 'alert'}
                size={30}
                color={step.pendingRetry ? c.warning : c.danger}
              />
            </View>
            <Text
              style={[
                styles.stateTitle,
                {color: step.pendingRetry ? c.warning : c.danger},
              ]}>
              {step.pendingRetry
                ? 'الصرف معلّق — بانتظار الاتصال'
                : 'تعذر صرف القسيمة'}
            </Text>
            <Text style={styles.stateText}>{step.message}</Text>
            {step.pendingRetry ? (
              <Text style={styles.stateMeta}>
                العملية محفوظة بمفتاحها نفسه وستكتمل تلقائياً — سيصلك إشعار عند
                الحسم. لا تُسلَّم البضاعة قبل نجاح الصرف.
              </Text>
            ) : null}
            <AppButton
              title={step.pendingRetry ? 'إغلاق' : 'إغلاق ومحاولة أخرى'}
              variant={step.permanent ? 'danger' : 'secondary'}
              onPress={onClose}
            />
          </View>
        ) : null}

        {step.phase !== 'calling' && step.phase !== 'success' ? (
          <TouchableOpacity
            style={styles.closeRow}
            onPress={onClose}
            activeOpacity={0.7}>
            <Text style={styles.closeText}>إلغاء</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    zIndex: 70,
    elevation: 70,
  },
  dim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    backgroundColor: '#1C1C24',
    borderTopLeftRadius: radius.lg + 4,
    borderTopRightRadius: radius.lg + 4,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.sm,
  },
  handle: {
    alignSelf: 'center',
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginBottom: spacing.xs,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  titleIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(249,115,22,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: '#F5F5F7',
    fontFamily: fonts.black,
    fontSize: typography.heading,
  },
  ruleBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(59,130,246,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.25)',
    borderRadius: radius.sm,
    padding: spacing.sm,
  },
  ruleText: {
    flex: 1,
    color: '#9EC5FE',
    fontFamily: fonts.regular,
    fontSize: typography.small,
    lineHeight: 17,
  },
  cartBox: {
    backgroundColor: 'rgba(249,115,22,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(249,115,22,0.22)',
    borderRadius: radius.sm,
    padding: spacing.sm,
    gap: 4,
  },
  cartRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cartLabel: {
    color: '#C9C9D4',
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  cartValue: {
    color: '#F5F5F7',
    fontFamily: fonts.bold,
    fontSize: typography.body,
  },
  cartHint: {
    color: '#8E8E9A',
    fontFamily: fonts.regular,
    fontSize: typography.micro,
  },
  /** v21 (round-27 #2): the exact-match rule, stated up front. */
  cartRule: {
    color: '#FDBA74',
    fontFamily: fonts.bold,
    fontSize: typography.micro + 1,
  },
  /** v21 (round-27 #1): standalone-redemption commitment note. */
  standaloneBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: 'rgba(59,130,246,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.20)',
    borderRadius: radius.sm,
    padding: spacing.sm,
  },
  standaloneText: {
    flex: 1,
    color: '#9EC5FE',
    fontFamily: fonts.regular,
    fontSize: typography.micro + 1,
    lineHeight: 16,
  },
  /** v21 (round-27 #2): exact-match confirmation / mismatch warning. */
  matchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'stretch',
    backgroundColor: 'rgba(74,222,128,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.30)',
    borderRadius: radius.sm,
    padding: spacing.sm,
  },
  matchText: {
    flex: 1,
    color: '#4ADE80',
    fontFamily: fonts.bold,
    fontSize: typography.micro + 1,
    lineHeight: 16,
  },
  mismatchBox: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderWidth: 1.5,
    borderColor: 'rgba(245,158,11,0.55)',
    borderRadius: radius.sm,
    padding: spacing.sm,
    gap: 4,
  },
  mismatchTitle: {
    color: '#FCD34D',
    fontFamily: fonts.black,
    fontSize: typography.small,
    textAlign: 'center',
  },
  mismatchText: {
    color: '#FDE68A',
    fontFamily: fonts.regular,
    fontSize: typography.micro + 1,
    textAlign: 'center',
    lineHeight: 16,
  },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: '#F97316',
    borderRadius: radius.md,
    padding: spacing.md,
  },
  scanBtnTitle: {
    color: '#FFFFFF',
    fontFamily: fonts.black,
    fontSize: typography.body,
  },
  scanBtnText: {
    color: 'rgba(255,255,255,0.82)',
    fontFamily: fonts.regular,
    fontSize: typography.small,
    marginTop: 2,
  },
  orRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  orLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  orText: {
    color: '#8E8E9A',
    fontFamily: fonts.regular,
    fontSize: typography.micro,
  },
  fieldWrap: {
    gap: 4,
  },
  fieldLabel: {
    color: '#C9C9D4',
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  fieldInput: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    borderRadius: radius.sm,
    color: '#F5F5F7',
    fontFamily: fonts.bold,
    fontSize: typography.heading,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    letterSpacing: 1.5,
  },
  fieldHint: {
    color: '#8E8E9A',
    fontFamily: fonts.regular,
    fontSize: typography.micro,
    textAlign: 'center',
  },
  stateBox: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  stateIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stateTitle: {
    color: '#F5F5F7',
    fontFamily: fonts.black,
    fontSize: typography.body + 2,
    textAlign: 'center',
  },
  stateText: {
    color: '#C9C9D4',
    fontFamily: fonts.regular,
    fontSize: typography.small,
    textAlign: 'center',
    lineHeight: 18,
  },
  stateMeta: {
    color: '#8E8E9A',
    fontFamily: fonts.regular,
    fontSize: typography.micro,
    textAlign: 'center',
    lineHeight: 16,
  },
  decompBox: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: radius.sm,
    padding: spacing.sm,
    gap: 6,
  },
  decompRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  decompLabel: {
    color: '#C9C9D4',
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  decompValue: {
    color: '#F5F5F7',
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
  decompRowTotal: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.12)',
    paddingTop: 8,
    marginTop: 2,
  },
  decompLabelTotal: {
    color: '#F5F5F7',
    fontFamily: fonts.black,
    fontSize: typography.body,
  },
  decompValueTotal: {
    color: '#F5F5F7',
    fontFamily: fonts.black,
    fontSize: typography.body,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignSelf: 'stretch',
    marginTop: spacing.xs,
  },
  closeRow: {
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  closeText: {
    color: '#8E8E9A',
    fontFamily: fonts.bold,
    fontSize: typography.small,
  },
});
