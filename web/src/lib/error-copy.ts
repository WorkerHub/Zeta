// The Spark failures the worker classifies with a code (spike report §2.3 / §2.6, extended by the
// config-profile and drain/rebuild work). The worker sends its own English sentence plus the code;
// the page prefers the copy for the current locale so every sentence exists in Chinese and English,
// which a worker-only string cannot do. Every other engine sends no code, and its message is shown
// as it arrives.
export type SparkErrorCode =
  | 'spark_stopped'
  | 'spark_not_ready'
  | 'spark_app_token'
  | 'spark_publish_token'
  // A rejected profile key (§5.2): the body carries the offending `key` so the UI can name it.
  | 'startup_key_in_profile'
  | 'invalid_key'
  // The machine's own environment state (§7.6): draining/restarting are transient (never a SQL
  // error, never a lost connection); rebuilt means the caller's session is gone and must reconnect.
  | 'context_draining'
  | 'context_restarting'
  | 'context_rebuilt'

const COPY_KEYS: Record<SparkErrorCode, string> = {
  spark_stopped: 'spark_error.spark_stopped',
  spark_not_ready: 'spark_error.spark_not_ready',
  spark_app_token: 'spark_error.spark_app_token',
  spark_publish_token: 'spark_error.spark_publish_token',
  startup_key_in_profile: 'spark_error.startup_key_in_profile',
  invalid_key: 'spark_error.invalid_key',
  context_draining: 'spark_error.context_draining',
  context_restarting: 'spark_error.context_restarting',
  context_rebuilt: 'spark_error.context_rebuilt',
}

// What a code means to the UI: an engine failure (shown as an error), a rejected profile key (the
// caller's own mistake, pointed at the key), or an environment state (informational, never red and
// never a knocked-back connection). `null` = not a Spark code at all.
export type SparkErrorKind = 'engine' | 'profile' | 'context' | null

const KIND: Record<SparkErrorCode, Exclude<SparkErrorKind, null>> = {
  spark_stopped: 'engine',
  spark_not_ready: 'engine',
  spark_app_token: 'engine',
  spark_publish_token: 'engine',
  startup_key_in_profile: 'profile',
  invalid_key: 'profile',
  context_draining: 'context',
  context_restarting: 'context',
  context_rebuilt: 'context',
}

function isSparkErrorCode(value: unknown): value is SparkErrorCode {
  return typeof value === 'string' && Object.hasOwn(COPY_KEYS, value)
}

/** The UI-facing class of a value that may or may not be a Spark error code. */
export function sparkErrorKind(value: unknown): SparkErrorKind {
  if (!isSparkErrorCode(value)) return null
  return KIND[value]
}

/**
 * The localised sentence for a failure body carrying a known `code`, or null when it carries none
 * (every non-Spark engine) — the caller then shows the worker's own message. `body.key` and
 * `body.inflight` fill the `{key}` / `{n}` placeholders where the copy names them.
 */
export function errorCodeText(
  t: (key: string, vars?: Record<string, string | number>) => string,
  body: unknown
): string | null {
  if (typeof body !== 'object' || body === null) return null
  const code = (body as { code?: unknown }).code
  if (!isSparkErrorCode(code)) return null
  const vars: Record<string, string | number> = {}
  const key = (body as { key?: unknown }).key
  if (typeof key === 'string' && key !== '') vars.key = key
  const inflight = (body as { inflight?: unknown }).inflight
  if (typeof inflight === 'number') vars.n = inflight
  return t(COPY_KEYS[code], vars)
}
