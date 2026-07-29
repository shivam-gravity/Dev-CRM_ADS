/**
 * Distinguishes "this deployment has no OAuth app registered" from "the OAuth attempt failed".
 *
 * The two need different handling and different words. A generic failure is worth a retry; a
 * missing app registration never is — retrying forever is exactly what a user does when told
 * "Please try again", and the only way forward is the manual-credentials path.
 *
 * A dedicated type (rather than sniffing the message, or forwarding the raw message into the
 * redirect URL) keeps the route's decision type-safe and keeps arbitrary error text — which may
 * carry internals like upstream URLs — out of a user-visible query string. The route maps this to a
 * stable error CODE and the UI owns the wording.
 */
export class OAuthNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthNotConfiguredError";
  }
}
