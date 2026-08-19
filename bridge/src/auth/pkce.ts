/**
 * PKCE (RFC 7636) code verifier/challenge generation, ported verbatim from OMP
 * packages/ai/src/registry/oauth/pkce.ts @ 8500092.
 *
 * Algorithm: verifier = base64url(96 random bytes); challenge =
 * base64url(SHA-256(verifier)) using the S256 method. The challenge half is
 * exposed as pkceChallengeFromVerifier so deterministic vectors can be tested
 * against fixed verifiers; generatePKCE's own behavior is unchanged.
 */

/** Compute the S256 PKCE challenge for an existing verifier. */
export async function pkceChallengeFromVerifier(verifier: string): Promise<string> {
  // Compute SHA-256 challenge
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(hashBuffer).toString("base64url");
}

/** Generate a random PKCE code verifier and its S256 challenge. */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  // Generate random verifier
  const verifierBytes = new Uint8Array(96);
  crypto.getRandomValues(verifierBytes);
  const verifier = Buffer.from(verifierBytes).toString("base64url");

  const challenge = await pkceChallengeFromVerifier(verifier);

  return { verifier, challenge };
}
