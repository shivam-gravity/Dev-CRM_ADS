import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { DEFAULT_CURRENCY, currencySymbol, formatDailyBudget, formatMoneyMinor, formatMoneyMinorCompact, type MoneyFormatOptions } from "../constants/money";

/**
 * Resolves the ONE currency every money value in the app is rendered in.
 *
 * Resolution order, and the reasoning behind it:
 *  1. An explicit user override (persisted per workspace). Provided because the product asked for
 *     a user-controlled currency, and because a workspace with no ad account yet still has to
 *     show budgets in something sensible.
 *  2. The CONNECTED AD ACCOUNT's currency — the default, because this is the currency Meta
 *     actually bills in. `integrationService.setMetaOAuthConnection` already stores it
 *     (`settings.currency`, fetched via metaOAuth.fetchAdAccountCurrency), so no new API is needed.
 *  3. USD, only as a last resort when nothing is connected.
 *
 * IMPORTANT CAVEAT on the override: Meta charges in the ad account's currency, full stop. If a
 * user overrides an INR account to display USD, every number on screen becomes a wrong number —
 * we are relabelling, not converting (there is no FX rate anywhere in this codebase). That is why
 * the ad account wins by DEFAULT and the override has to be set deliberately. `isOverridden` is
 * exposed so a Settings screen can warn when the displayed currency disagrees with billing.
 */

const OVERRIDE_STORAGE_PREFIX = "polluxa_currency_override:";

interface CurrencyContextValue {
  /** ISO 4217 code the UI should render amounts in. */
  currency: string;
  /** Short symbol for compact labels, e.g. the "Daily Budget (₹)" field label. */
  symbol: string;
  /** The connected ad account's real billing currency, or null when nothing is connected. */
  billingCurrency: string | null;
  /** True when a user override is in effect AND it disagrees with the billing currency. */
  isOverridden: boolean;
  /** Still resolving — render amounts, but expect the symbol to settle a beat later. */
  isLoading: boolean;
  setOverride: (currency: string | null) => void;
  /** Format an app-internal minor amount (wholeUnits * 100) in the resolved currency. */
  format: (minor: number | null | undefined, options?: MoneyFormatOptions) => string;
  /** Same, with no decimal places — budgets, chips, table cells. */
  formatCompact: (minor: number | null | undefined) => string;
  /** "₹100/day". */
  formatDaily: (minor: number | null | undefined) => string;
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const { workspaceId } = useAuth();
  const [billingCurrency, setBillingCurrency] = useState<string | null>(null);
  const [override, setOverrideState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const storageKey = workspaceId ? `${OVERRIDE_STORAGE_PREFIX}${workspaceId}` : null;

  // Load the persisted override whenever the workspace changes — it is stored PER workspace so
  // switching tenants can't leak one workspace's display choice onto another's numbers.
  useEffect(() => {
    if (!storageKey) return setOverrideState(null);
    setOverrideState(localStorage.getItem(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (!workspaceId) {
      setBillingCurrency(null);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    api
      .listIntegrations(workspaceId)
      .then((integrations) => {
        if (cancelled) return;
        // Prefer the ad platform we actually bill through. Only a CONNECTED integration counts:
        // a disconnected/errored row can hold a stale currency from a previous account.
        const connected = integrations.filter((i) => i.status === "connected");
        const source =
          connected.find((i) => i.platform === "meta") ??
          connected.find((i) => i.platform === "google") ??
          null;
        const code = typeof source?.settings?.currency === "string" ? (source.settings.currency as string) : null;
        setBillingCurrency(code && code.trim() ? code.trim().toUpperCase() : null);
      })
      // A failed lookup must not break the page — fall through to the default currency.
      .catch(() => {
        if (!cancelled) setBillingCurrency(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const setOverride = useCallback(
    (next: string | null) => {
      const normalized = next?.trim().toUpperCase() || null;
      setOverrideState(normalized);
      if (!storageKey) return;
      if (normalized) localStorage.setItem(storageKey, normalized);
      else localStorage.removeItem(storageKey);
    },
    [storageKey]
  );

  const value = useMemo<CurrencyContextValue>(() => {
    const currency = override ?? billingCurrency ?? DEFAULT_CURRENCY;
    return {
      currency,
      symbol: currencySymbol(currency),
      billingCurrency,
      isOverridden: Boolean(override && billingCurrency && override !== billingCurrency),
      isLoading,
      setOverride,
      format: (minor, options) => formatMoneyMinor(minor, currency, options),
      formatCompact: (minor) => formatMoneyMinorCompact(minor, currency),
      formatDaily: (minor) => formatDailyBudget(minor, currency),
    };
  }, [override, billingCurrency, isLoading, setOverride]);

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

/**
 * Money formatting for the resolved workspace currency.
 *
 * Safe to call outside the provider: it degrades to USD formatting rather than throwing, so a
 * component rendered in isolation (tests, a stray route outside the tree) still renders. Prefer
 * keeping the provider mounted at the app root — see App.tsx.
 */
export function useCurrency(): CurrencyContextValue {
  const ctx = useContext(CurrencyContext);
  if (ctx) return ctx;
  return {
    currency: DEFAULT_CURRENCY,
    symbol: currencySymbol(DEFAULT_CURRENCY),
    billingCurrency: null,
    isOverridden: false,
    isLoading: false,
    setOverride: () => {},
    format: (minor, options) => formatMoneyMinor(minor, DEFAULT_CURRENCY, options),
    formatCompact: (minor) => formatMoneyMinorCompact(minor, DEFAULT_CURRENCY),
    formatDaily: (minor) => formatDailyBudget(minor, DEFAULT_CURRENCY),
  };
}
