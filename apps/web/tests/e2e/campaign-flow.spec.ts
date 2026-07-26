import { test, expect, type Page } from "@playwright/test";

/**
 * Critical-path smoke test: the URL-to-Campaign flow.
 *
 * Journey covered: land on the Campaign Generator → paste a product URL and parse it into a
 * product card → (Meta + Google are the default active channels) → click Generate → the button
 * shows its loading state → the app routes to the Ads Manager / campaign view for the new campaign.
 *
 * NO real backend runs. Every network call the flow makes is intercepted with page.route():
 *  - Auth bootstrap: /auth/me + /workspaces/* (in DEV the app seeds a demo workspace/business and
 *    only needs these to resolve for RequireAuth to pass — see AuthContext.tsx).
 *  - Product add: /onboarding/scrape + /onboarding/analyze-product.
 *  - Generation: /campaigns/generate returns a COMPLETED job with a campaignId, so the flow
 *    navigates straight to /campaigns/:id (no polling loop) — the fast, deterministic smoke path.
 *  - Destination: /campaigns/:id (+ perf/trend) so the campaign view renders.
 *
 * The mocked account is named "Aradhna Srivastava" (the advertiser profile from the plan). The
 * generator form itself has no account-name input, so the name is exercised via the auth/me +
 * workspace identity that the app header renders, rather than typed into the form.
 */

const ACCOUNT_NAME = "Aradhna Srivastava";
const WORKSPACE_ID = "demo-workspace";
const BUSINESS_ID = "demo-business";
const PRODUCT_URL = "https://example.com/premium-widget";
const NEW_CAMPAIGN_ID = "camp_e2e_smoke_1";

function isoNow(): string {
  // Fixed timestamp keeps mocks deterministic (Date.now() isn't needed for correctness here).
  return "2026-01-01T00:00:00.000Z";
}

/** Registers all backend mocks for the happy path. Order-independent: Playwright matches by URL. */
async function mockBackend(page: Page): Promise<void> {
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  // Safety net for OTHER backend calls the flow may make incidentally (notifications, insights,
  // unread counts, etc.) — an empty-but-valid JSON body so an unmocked call can't spuriously fail
  // the smoke test. Registered FIRST on purpose: Playwright matches handlers in REVERSE
  // registration order (last wins), so every specific route below overrides this catch-all.
  //
  // A REGEX anchored to the origin's `/api/` path (NOT a "**/api/**" glob): the app's own source
  // module `http://localhost:5173/src/api/client.ts` also contains "/api/", and a glob would
  // intercept it and serve JS-module requests as JSON — which prevents the app from booting.
  await page.route(/^https?:\/\/[^/]+\/api\//, (route) => route.fulfill(json({})));

  // ── Auth bootstrap ────────────────────────────────────────────────────────────────────────
  await page.route("**/api/auth/me", (route) =>
    route.fulfill(json({ id: "user_e2e", email: "aradhna@example.com", name: ACCOUNT_NAME, createdAt: isoNow() })),
  );
  await page.route(`**/api/workspaces/${WORKSPACE_ID}`, (route) =>
    route.fulfill(json({ id: WORKSPACE_ID, name: `${ACCOUNT_NAME}'s Workspace`, ownerId: "user_e2e", plan: "pro", timezone: "UTC", createdAt: isoNow() })),
  );

  // ── Product add (URL → scrape → analyze) ───────────────────────────────────────────────────
  await page.route("**/api/onboarding/scrape", (route) =>
    route.fulfill(json({
      url: PRODUCT_URL,
      title: "Premium Widget",
      description: "The best widget for modern teams.",
      excerpt: "The best widget for modern teams.",
      images: [],
      crawledPages: [PRODUCT_URL],
      pagesDiscovered: 1,
    })),
  );
  await page.route("**/api/onboarding/analyze-product", (route) =>
    route.fulfill(json({
      productName: "Premium Widget",
      category: "SaaS",
      summary: "A premium widget that helps teams move faster.",
      valueProposition: "Move faster with less overhead.",
      keyFeatures: ["Fast", "Reliable", "Affordable"],
    })),
  );

  // ── Generation: complete with a campaignId so the flow routes to the campaign ───────────────
  await page.route("**/api/campaigns/generate", async (route) => {
    // Assert the request actually carries Meta + Google as the selected channels.
    const payload = route.request().postDataJSON() as { channels?: string[] };
    expect(payload.channels ?? []).toEqual(expect.arrayContaining(["meta", "google"]));
    // Small deliberate delay so the button's "Generating..." loading state is observable before
    // navigation (an instant fulfill would race past it). Still returns "completed" so the flow
    // routes straight to the campaign without entering the status-polling loop.
    await new Promise((r) => setTimeout(r, 400));
    return route.fulfill(json({
      id: "job_e2e_1",
      status: "completed",
      campaignId: NEW_CAMPAIGN_ID,
      decisionContext: null,
      updatedAt: isoNow(),
    }));
  });

  // ── Destination: campaign detail view renders after navigation ──────────────────────────────
  await page.route(`**/api/campaigns/${NEW_CAMPAIGN_ID}`, (route) =>
    route.fulfill(json({
      id: NEW_CAMPAIGN_ID,
      businessId: BUSINESS_ID,
      workspaceId: WORKSPACE_ID,
      strategyId: "strat_e2e_1",
      name: "Sales — Meta Ads + Google Ads",
      status: "paused",
      networks: ["meta", "google"],
      dailyBudgetCents: 5000,
      variants: [],
      createdAt: isoNow(),
      updatedAt: isoNow(),
    })),
  );
  await page.route(`**/api/campaigns/${NEW_CAMPAIGN_ID}/performance`, (route) => route.fulfill(json([])));
  await page.route(`**/api/campaigns/${NEW_CAMPAIGN_ID}/trend`, (route) => route.fulfill(json([])));
}

test.describe("URL-to-Campaign core flow", () => {
  test.beforeEach(async ({ page, context }) => {
    await mockBackend(page);
    // Seed the DEV demo identity the app expects in localStorage BEFORE any app script runs, so
    // RequireAuth sees a businessId synchronously and doesn't bounce to /get-started.
    await context.addInitScript(([wsId, bizId]) => {
      localStorage.setItem("polluxa_workspace_id", wsId);
      localStorage.setItem("businessId", bizId);
    }, [WORKSPACE_ID, BUSINESS_ID]);
  });

  test("generates a campaign from a product URL and lands on the campaign view", async ({ page }) => {
    await page.goto("/campaigns/generator");

    // The generator screen is up. The page title now lives in the shell breadcrumb (a <span>,
    // not a heading — see the PageHeaderContext refactor), so we assert on the generator's own
    // "Add products to promote" section heading, which is unique to this page and confirms the
    // page body (not just the app shell) rendered.
    await expect(page.getByRole("heading", { name: "Add products to promote" })).toBeVisible();

    // Meta + Google are the default active channels for this page. The visible channel picker
    // now lives in the Deep Research flow (PromotionObjectiveCard on /campaigns/new); on the
    // generator the channels are internal defaults with no control, so we assert the default
    // directly on the outgoing /campaigns/generate payload (see that route handler above).

    // Add a product: paste the URL and parse it into a product card.
    await page.getByTestId("product-url-input").fill(PRODUCT_URL);
    await page.getByTestId("parse-url-button").click();
    // exact:true so this matches the product card's <strong>Premium Widget</strong> title and not
    // the (substring-containing) summary paragraph below it.
    await expect(page.getByText("Premium Widget", { exact: true })).toBeVisible();

    // Generate. The button label flips to its loading state, then the app routes to the campaign.
    const generateButton = page.getByTestId("generate-campaign-button");
    await expect(generateButton).toBeEnabled();
    await generateButton.click();

    // Loading state: the button disables and shows "Generating..." while the mocked (delayed)
    // generate call is in flight.
    await expect(generateButton).toBeDisabled();
    await expect(generateButton).toHaveText(/Generating/i);

    // The core assertion: the flow transitioned to the new campaign's view.
    await expect(page).toHaveURL(new RegExp(`/campaigns/${NEW_CAMPAIGN_ID}$`));
    await expect(page.getByRole("heading", { name: "Sales — Meta Ads + Google Ads" })).toBeVisible();
  });

  test("blocks generation with a clear error when no product has been added", async ({ page }) => {
    await page.goto("/campaigns/generator");
    await expect(page.getByRole("heading", { name: "Add products to promote" })).toBeVisible();

    // Click Generate with channels defaulted but NO product added.
    await page.getByTestId("generate-campaign-button").click();

    // Stays on the generator and surfaces the guard message — never navigates away.
    await expect(page.getByText("Add at least one product to promote.")).toBeVisible();
    await expect(page).toHaveURL(/\/campaigns\/generator$/);
  });
});
