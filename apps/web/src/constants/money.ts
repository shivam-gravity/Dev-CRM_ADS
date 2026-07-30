/**
 * Currency formatting for every money value the UI shows.
 *
 * WHY THIS EXISTS: the app used to hardcode a `$` in front of every amount (`$${cents/100}`),
 * which is actively wrong — Meta bills in the AD ACCOUNT's currency, so an INR account was
 * shown "$100/day" for what Meta charges as ₹100/day. That is a ~85x misstatement of spend,
 * not a cosmetic issue. Every amount must be rendered through here with the resolved currency.
 *
 * MINOR UNITS: the backend stores every budget/spend as `wholeUnits * 100` REGARDLESS of the
 * currency (see metaAdapter.toMetaMinorUnits — it converts to the real minor unit only at the
 * Graph API boundary). So dividing by 100 is always correct app-side; only the symbol and the
 * digit grouping change per currency. Do NOT "fix" this by dividing by a per-currency divisor.
 */

/** Currencies Meta bills in that have no minor unit — displaying "₩1,000.00" is wrong. */
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW", "VND", "CLP", "HUF", "ISK", "TWD", "IDR"]);

export const DEFAULT_CURRENCY = "USD";

/**
 * Symbols for the currencies most likely to appear, used for compact contexts (chips, table
 * cells) where `Intl`'s longer output would wrap. `Intl.NumberFormat` is still the source of
 * truth for the NUMBER; this only supplies a short prefix.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", INR: "₹", JPY: "¥", CNY: "¥", KRW: "₩",
  AUD: "A$", CAD: "C$", SGD: "S$", NZD: "NZ$", HKD: "HK$", BRL: "R$",
  MXN: "MX$", ZAR: "R", AED: "د.إ", SAR: "﷼", TRY: "₺", THB: "฿",
  PHP: "₱", IDR: "Rp", MYR: "RM", VND: "₫", PLN: "zł", SEK: "kr",
  NOK: "kr", DKK: "kr", CHF: "CHF", ILS: "₪", NGN: "₦", KES: "KSh",
};

export function currencySymbol(currency: string | undefined): string {
  const code = (currency ?? DEFAULT_CURRENCY).toUpperCase();
  return CURRENCY_SYMBOLS[code] ?? `${code} `;
}

function decimalsFor(code: string, requested?: number): number {
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  return requested ?? 2;
}

export interface MoneyFormatOptions {
  /** Decimal places. Defaults to 2 (0 for zero-decimal currencies, which always win). */
  decimals?: number;
  /** Render the ISO code instead of a symbol (e.g. reports, exports, ambiguous "kr"/"$" cases). */
  useCode?: boolean;
}

/**
 * Format an app-internal minor amount (`wholeUnits * 100`) in `currency`.
 * Falls back to a manual symbol + grouped number if `Intl` rejects the code, so an unexpected
 * currency degrades to something readable rather than throwing inside a render.
 */
export function formatMoneyMinor(minor: number | null | undefined, currency: string | undefined, options: MoneyFormatOptions = {}): string {
  const code = (currency ?? DEFAULT_CURRENCY).toUpperCase();
  const amount = (minor ?? 0) / 100;
  const digits = decimalsFor(code, options.decimals);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      currencyDisplay: options.useCode ? "code" : "narrowSymbol",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    const grouped = amount.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return `${currencySymbol(code)}${grouped}`;
  }
}

/**
 * Format an amount already in WHOLE currency units.
 *
 * Several dashboards divide by 100 before formatting, so they hold e.g. `12.34` rather than `1234`.
 * Giving those call sites their own function avoids a `* 100` at each one, which is exactly the
 * kind of scattered arithmetic that produces a 100x-wrong number when someone edits it later.
 */
export function formatMoneyWhole(amount: number | null | undefined, currency: string | undefined, options: MoneyFormatOptions = {}): string {
  return formatMoneyMinor(Math.round((amount ?? 0) * 100), currency, options);
}

/** `formatMoneyMinor` with no decimals — for budgets/chips where cents are noise. */
export function formatMoneyMinorCompact(minor: number | null | undefined, currency: string | undefined): string {
  return formatMoneyMinor(minor, currency, { decimals: 0 });
}

/** "₹100/day" — the budget shorthand used in tables, chips and rule summaries. */
export function formatDailyBudget(minor: number | null | undefined, currency: string | undefined): string {
  return `${formatMoneyMinorCompact(minor, currency)}/day`;
}
