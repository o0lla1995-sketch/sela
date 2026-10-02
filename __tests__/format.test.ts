/**
 * Unit tests for the pure formatting logic (no native modules needed).
 */
import {formatMoney, nextInvoiceNumber, weekdayLabel, parseNumber} from '../src/core/format';

describe('formatMoney', () => {
  it('formats positive amounts with shekel suffix', () => {
    expect(formatMoney(12.5)).toBe('12.50 ₪');
  });

  it('adds thousands separators', () => {
    expect(formatMoney(12345.678)).toBe('12,345.68 ₪');
  });

  it('handles negative amounts', () => {
    expect(formatMoney(-3)).toBe('-3.00 ₪');
  });

  it('falls back to zero for non-finite input', () => {
    expect(formatMoney(Number.NaN)).toBe('0.00 ₪');
  });
});

describe('nextInvoiceNumber', () => {
  it('increments within the same day', () => {
    const result = nextInvoiceNumber(3, '2026-10-02', '2026-10-02');
    expect(result.invoiceNumber).toBe('INV-20261002-0004');
    expect(result.counter).toBe(4);
  });

  it('resets for a new day', () => {
    const result = nextInvoiceNumber(99, '2026-10-01', '2026-10-02');
    expect(result.invoiceNumber).toBe('INV-20261002-0001');
    expect(result.counter).toBe(1);
  });
});

describe('weekdayLabel', () => {
  it('maps a date to its Arabic weekday', () => {
    // 2026-10-02 is a Friday.
    expect(weekdayLabel('2026-10-02')).toBe('الجمعة');
  });
});

describe('parseNumber', () => {
  it('parses plain numbers', () => {
    expect(parseNumber('4.5')).toBe(4.5);
  });

  it('strips non-numeric characters', () => {
    expect(parseNumber('12abc')).toBe(12);
  });

  it('returns NaN for empty input', () => {
    expect(Number.isNaN(parseNumber(''))).toBe(true);
  });
});
