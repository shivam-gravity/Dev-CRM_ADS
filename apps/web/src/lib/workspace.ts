/**
 * The one place the current workspace id is resolved.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────
 * Twenty-three components each wrote their own version of:
 *
 *     const wsId = localStorage.getItem("polluxa_workspace_id") ?? "demo-workspace";
 *
 * so whenever no workspace was loaded, every one of them sent requests naming a workspace that was
 * simply invented. Nothing bad happens while no such workspace exists — measured on production:
 * no "demo-workspace" row, one tenant, zero campaigns with a null workspace — but it is a latent
 * trap rather than a safe default. The moment a workspace with that id exists (a seed script, a
 * fixture restored into a shared database, someone naming one "demo-workspace"), every un-scoped
 * component starts addressing a real tenant that is not the user's, and the request is
 * well-formed enough to be authorized if they happen to be a member.
 *
 * Failing closed is strictly better: an empty id cannot match anything, so the server rejects it
 * and the user sees an error, instead of quietly reading or writing somewhere plausible.
 *
 * Dev convenience is unaffected — AuthContext still seeds localStorage explicitly under
 * `import.meta.env.DEV`, so a dev session has a real value here and never reaches the fallback.
 */

const WORKSPACE_STORAGE_KEY = "polluxa_workspace_id";

/**
 * Current workspace id, or "" when none is known.
 *
 * Pass the AuthContext value as `preferred` where a component has it — that is the freshest source,
 * and localStorage is only the cross-reload cache behind it.
 *
 * Returns a string (not null) deliberately: these call sites feed it straight into request paths and
 * hook dependency arrays, and widening 23 of them to `string | null` would spread null-handling far
 * beyond the problem being fixed. "" is the fail-closed sentinel — see hasWorkspace.
 */
export function currentWorkspaceId(preferred?: string | null): string {
  const resolved = preferred?.trim() || localStorage.getItem(WORKSPACE_STORAGE_KEY)?.trim() || "";
  if (!resolved && import.meta.env.DEV) {
    console.warn("currentWorkspaceId: no workspace in context or storage — request will fail closed rather than guess one.");
  }
  return resolved;
}

/** Guard for "should I even make this call / render this panel yet?". */
export function hasWorkspace(workspaceId: string | null | undefined): boolean {
  return Boolean(workspaceId && workspaceId.trim());
}
