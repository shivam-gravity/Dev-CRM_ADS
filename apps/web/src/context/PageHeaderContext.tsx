import { createContext, useContext, useEffect, useState, ReactNode } from "react";

/**
 * Drives the single, shell-level PolluxaHeader (breadcrumb + optional right-hand slot).
 *
 * The header used to be rendered ad-hoc by each page, which meant most pages either
 * lacked it entirely or shipped a broken hand-rolled copy (dead profile dropdown, fake
 * user). It now lives once in the app shell (see App.tsx) and reads its breadcrumb from
 * the route by default; pages that need a *dynamic* breadcrumb (e.g. a campaign name) or
 * a page-specific control in the header (e.g. Ads Manager's "Manage Funds") push it here
 * via usePageHeader().
 */
export interface HeaderConfig {
  breadcrumb?: string[];
  rightSlot?: ReactNode;
}

interface PageHeaderContextValue {
  config: HeaderConfig;
  setConfig: (c: HeaderConfig) => void;
}

const PageHeaderContext = createContext<PageHeaderContextValue | null>(null);

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<HeaderConfig>({});
  return <PageHeaderContext.Provider value={{ config, setConfig }}>{children}</PageHeaderContext.Provider>;
}

export function usePageHeaderConfig(): PageHeaderContextValue {
  const ctx = useContext(PageHeaderContext);
  if (!ctx) throw new Error("usePageHeaderConfig must be used within a PageHeaderProvider");
  return ctx;
}

/**
 * Page-side hook: override the shell header's breadcrumb and/or inject a right-hand slot
 * while this page is mounted; the override is cleared automatically on unmount so the
 * next page falls back to its route-derived default.
 *
 * `rightSlotDeps` re-runs the effect when the slot's inputs change (its length must be
 * constant per call site, per the rules of hooks). Breadcrumb changes are tracked
 * automatically.
 */
export function usePageHeader(opts: { breadcrumb?: string[]; rightSlot?: ReactNode; rightSlotDeps?: unknown[] }) {
  const { setConfig } = usePageHeaderConfig();
  const breadcrumbKey = opts.breadcrumb?.join(" › ");
  useEffect(() => {
    setConfig({ breadcrumb: opts.breadcrumb, rightSlot: opts.rightSlot });
    return () => setConfig({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [breadcrumbKey, ...(opts.rightSlotDeps ?? [])]);
}
