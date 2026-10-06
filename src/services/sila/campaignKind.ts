/**
 * campaignKind — v25 (round-32 #2) the campaign-type classifier.
 * ─────────────────────────────────────────────────────────────────
 * The merchant's rule: a campaign's TYPE is readable from its TITLE
 * before anything else —
 *   • «قسيمة شرائية _ <name>»  → a PURCHASE-COUPON campaign
 *     (the قسيمة button in the POS cart, redeemed from the cart).
 *   • «طرد <name>»            → a PARCEL campaign
 *     (redeemed ONLY from the القسائم tab's parcel button).
 *
 * The classification ladder (STRICT, no cross-over ever):
 *   1. TITLE first — the institution's naming convention is the
 *      authoritative signal the merchant can SEE. A title that
 *      contains طرد (at a word start) is a parcel even if the
 *      server's kind field says otherwise; a title that says
 *      قسيمة / شرائية is a purchase coupon the same way.
 *   2. The server's kind field ('voucher' | 'parcel').
 *   3. Default: purchase coupon — parcel campaigns are ALWAYS titled
 *      طرد by the institution, so an untitled kind-less row can
 *      only be a purchase campaign.
 */

export type CampaignKind = 'voucher' | 'parcel';

/** True when the title's first word(s) mark a PARCEL campaign. */
function titleSaysParcel(name: string): boolean {
  // «طرد» as its own word at the START of the title (the convention:
  // «طرد رمضان»، «طرد بدون سلة»…). Allow a leading emoji/whitespace
  // noise the institution may prepend.
  const cleaned = name.replace(/^[\s\u200f\u200e\p{Extended_Pictographic}]+/u, '');
  return /^طرد(\s|$|_|-)/.test(cleaned) || cleaned.startsWith('طرد');
}

/** True when the title names a PURCHASE-COUPON campaign. */
function titleSaysVoucher(name: string): boolean {
  return name.includes('قسيمة') || name.includes('شرائية') || name.includes('قسائم');
}

export function classifyCampaignKind(
  kind: string | null | undefined,
  name: string | null | undefined,
): CampaignKind {
  const title = (name ?? '').trim();
  if (title.length > 0) {
    if (titleSaysParcel(title)) {
      return 'parcel';
    }
    if (titleSaysVoucher(title)) {
      return 'voucher';
    }
  }
  const serverKind = (kind ?? '').trim().toLowerCase();
  if (serverKind === 'parcel') {
    return 'parcel';
  }
  // 'voucher', any other vocabulary, or nothing at all — the default
  // is the purchase coupon (see header note 3).
  return 'voucher';
}
