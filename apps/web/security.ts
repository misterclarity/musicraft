/**
 * The Content-Security-Policy of the deployed app, in one place.
 *
 * Netlify (netlify.toml) and Vercel (vercel.json) send it as a header, together with frame-ancestors.
 * GitHub Pages can't send headers, so every production build also carries it in a <meta> tag
 * (frame-ancestors only works as a header). src/security.test.ts checks that the three stay in sync.
 */
export const CSP_DIRECTIVES = [
  "default-src 'self'",
  // WebAssembly (Verovio) needs wasm-unsafe-eval; no other script than the app's own.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  // Your server (any https address you enter in Settings), and local servers while testing.
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
] as const;

/** For the <meta> tag. */
export const META_CSP = CSP_DIRECTIVES.join("; ");

/** For the header (adds protection against being framed by other sites). */
export const HEADER_CSP = [...CSP_DIRECTIVES, "frame-ancestors 'none'"].join("; ");
