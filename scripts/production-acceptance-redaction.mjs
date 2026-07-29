/**
 * Format-independent last line of defence for persisted acceptance
 * diagnostics. Exact secret replacement is still performed by the caller,
 * because Compose may serialize PEM values with indentation or quoting.
 */
export function redactAcceptanceDiagnostic(value) {
  return String(value ?? "")
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]"
    )
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PUBLIC KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PUBLIC KEY-----/g,
      "[REDACTED_PUBLIC_KEY]"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, "Bearer [REDACTED]")
    .replace(/(postgresql:\/\/[^:]+:)[^@\s]+@/g, "$1[REDACTED]@");
}
