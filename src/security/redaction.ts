// Secret redaction for everything the timeline keeps and every export writes.
// Pattern-based and best effort: it catches the common credential shapes and
// every inline environment assignment, it cannot prove a string holds no secret.

export const REDACTED = '[REDACTED]'

/** Object keys whose values are dropped whole, matched per word (`apiKey` is `api_key`). */
const SENSITIVE_KEY =
  /(^|_)(password|passwd|passphrase|pass|pwd|secret|token|api_?key|auth|authorization|cookie|credentials?|private_?key|session_?(id|key)|bearer|access_?key)(_|$)/

/** Credential shapes replaced wherever they appear in a string. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]

/** `scheme://user:password@host` keeps the user, drops the password. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi

/** `KEY=value` (shell env assignment, `export`, `set`, `env`): the value goes. */
const ENV_ASSIGNMENT = /(^|[\s;&|(`])((?:export\s+|set\s+)?[A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)`]+)/g

/** PowerShell `$env:NAME = value`. */
const PS_ENV_ASSIGNMENT = /(\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi

/** `--password x`, `--token=x`, `-p:x` style secret flags. */
const SECRET_FLAG =
  /(--?(?:password|passwd|pass|token|secret|api[-_]?key|auth(?:-token)?|access[-_]?key|client[-_]?secret)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi

/** Header-style `Authorization: x`, `X-Api-Key: x`. */
const SECRET_HEADER = /\b((?:authorization|x-api-key|api-key|cookie|set-cookie)\s*:\s*)([^\s"',;]+(?:\s+[^\s"',;]+)?)/gi

export function redactString(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED)
  return out
    .replace(URL_CREDENTIALS, `$1:${REDACTED}@`)
    .replace(ENV_ASSIGNMENT, `$1$2=${REDACTED}`)
    .replace(PS_ENV_ASSIGNMENT, `$1${REDACTED}`)
    .replace(SECRET_FLAG, `$1${REDACTED}`)
    .replace(SECRET_HEADER, `$1${REDACTED}`)
}

export function isSensitiveKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s.]+/g, '_').toLowerCase()
  return SENSITIVE_KEY.test(words)
}

/** Deep copy of plain JSON data with sensitive keys and secret shapes redacted. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (depth > 8) return '[…]'
  if (Array.isArray(value)) return value.map(item => redactValue(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) && item !== null && item !== undefined ? REDACTED : redactValue(item, depth + 1)
  }
  return out
}
