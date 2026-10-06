/**
 * cashReceipt — v25 (round-32 #3) the thermal slip for ONE cash
 * movement (مصروف / سحب رصيد / إيداع) and the period STATEMENT slip.
 * ─────────────────────────────────────────────────────────────────
 * Same layout language as the debt/return receipts: store header,
 * a bold titled box, the amount double-sized, the numbered
 * reference, and — for secured withdrawals — the authorization
 * method line (بصمة / رمز) so the paper trail matches the books.
 */
import {ReceiptBuilder} from './escpos';
import type {ReceiptSettings} from './receipt';
import {RECEIPT_WIDTH_58, RECEIPT_WIDTH_80} from '../../core/config';
import type {
  CashAuthMethod,
  CashMovementKind,
  CashMovementRecord,
} from '../../core/types';

const TITLES: Record<CashMovementKind, string> = {
  expense: 'سند مصروف من الخزينة',
  withdrawal: 'سند سحب رصيد من الخزينة',
  deposit: 'سند إيداع نقدي للخزينة',
};

const AUTH_LABEL: Record<CashAuthMethod, string> = {
  fingerprint: 'مؤمَّن بالبصمة',
  pin: 'مؤمَّن برمز الدخول',
  none: 'بدون تأمين إلكتروني',
};

export interface CashMovementReceiptData {
  movement: CashMovementRecord;
  /** The drawer's expected cash AFTER this movement (info line). */
  drawerAfterMinor: number | null;
}

export function buildCashMovementJob(
  data: CashMovementReceiptData,
  settings: ReceiptSettings,
) {
  const width =
    settings.paperWidth === '58' ? RECEIPT_WIDTH_58 : RECEIPT_WIDTH_80;
  const rasterWidth = settings.paperWidth === '58' ? 384 : 576;
  const b = ReceiptBuilder.create();
  const m = data.movement;
  const amount = (m.amount_minor / 100).toFixed(2);

  if (settings.storeLogoPath) {
    b.image(settings.storeLogoPath, rasterWidth).feed(1);
  }

  b.codepage(settings.codepage)
    .align(1)
    .bold(true)
    .size(1, 1)
    .textLine(settings.storeName || 'sela')
    .size(0, 0)
    .bold(false);
  if (settings.storePhone.trim()) {
    b.align(1).textLine(`Tel: ${settings.storePhone.trim()}`);
  }

  b.align(2).separator(width).bold(true).size(1, 1).align(1)
    .textLine(TITLES[m.kind])
    .size(0, 0)
    .bold(false)
    .align(2)
    .separator(width)
    .textLine(m.ref)
    .textLine(m.created_at)
    .separator(width)
    .align(2)
    .bold(true)
    .textLine(`Amount: ${amount} ILS`)
    .bold(false)
    .separator(width)
    .align(2)
    .textLine(`Category: ${m.category}`);
  if (m.note) {
    b.align(2).textLine(`Note: ${m.note}`);
  }
  b.align(2).textLine(AUTH_LABEL[m.auth_method]);
  if (data.drawerAfterMinor != null) {
    b.separator(width)
      .align(2)
      .textLine(`Drawer now: ${(data.drawerAfterMinor / 100).toFixed(2)} ILS`);
  }
  b.separator(width)
    .align(1)
    .bold(true)
    .textLine(settings.footerMessage || 'شكراً لتعاملكم معنا')
    .bold(false)
    .feed(2)
    .cut();
  return b.build();
}

export interface CashStatementReceiptData {
  /** 'YYYY-MM-DD' → 'YYYY-MM-DD' (already formatted for display). */
  periodLabel: string;
  rows: CashMovementRecord[];
  expensesMinor: number;
  withdrawalsMinor: number;
  depositsMinor: number;
  netMinor: number;
  drawerNowMinor: number | null;
}

/** The period statement as a LONG thermal slip — the merchant's
 *  pocket audit trail (the PDF covers the archival A4 copy). */
export function buildCashStatementJob(
  data: CashStatementReceiptData,
  settings: ReceiptSettings,
) {
  const width =
    settings.paperWidth === '58' ? RECEIPT_WIDTH_58 : RECEIPT_WIDTH_80;
  const b = ReceiptBuilder.create();

  b.codepage(settings.codepage)
    .align(1)
    .bold(true)
    .size(1, 1)
    .textLine(settings.storeName || 'sela')
    .size(0, 0)
    .bold(false)
    .textLine('كشف المصروفات والسحوبات')
    .textLine(data.periodLabel)
    .separator(width)
    .align(2);

  const lines = Math.min(data.rows.length, 60);
  for (let i = 0; i < lines; i += 1) {
    const row = data.rows[i];
    const sign = row.kind === 'deposit' ? '+' : '-';
    b.textLine(
      `${row.created_at.slice(5, 16)} ${sign}${(
        row.amount_minor / 100
      ).toFixed(2)} ${row.category} ${row.ref}`,
    );
  }
  if (data.rows.length > lines) {
    b.textLine(`... +${data.rows.length - lines} More`);
  }

  b.separator(width)
    .bold(true)
    .textLine(`Expenses: -${(data.expensesMinor / 100).toFixed(2)} ILS`)
    .textLine(`Withdrawals: -${(data.withdrawalsMinor / 100).toFixed(2)} ILS`)
    .textLine(`Deposits: +${(data.depositsMinor / 100).toFixed(2)} ILS`)
    .separator(width)
    .size(1, 1)
    .textLine(`Net: ${(data.netMinor / 100).toFixed(2)} ILS`)
    .size(0, 0)
    .bold(false);
  if (data.drawerNowMinor != null) {
    b.textLine(`Drawer now: ${(data.drawerNowMinor / 100).toFixed(2)} ILS`);
  }
  b.feed(2).cut();
  return b.build();
}
