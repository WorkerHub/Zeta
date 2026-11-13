// The Spark failures the worker classifies with a code (spike report §2.3 / §2.6). The worker sends
// its own English sentence plus the code; the page prefers the copy for the current locale so the
// four sentences exist in Chinese and English, which a worker-only string cannot do. Every other
// engine sends no code, and its message is shown as it arrives.
export type SparkErrorCode = 'spark_stopped' | 'spark_not_ready' | 'spark_app_token' | 'spark_publish_token'

const COPY_KEYS: Record<SparkErrorCode, string> = {
  spark_stopped: 'spark_error.spark_stopped',
  spark_not_ready: 'spark_error.spark_not_ready',
  spark_app_token: 'spark_error.spark_app_token',
  spark_publish_token: 'spark_error.spark_publish_token',
}

function isSparkErrorCode(value: unknown): value is SparkErrorCode {
  return typeof value === 'string' && Object.hasOwn(COPY_KEYS, value)
}

/**
 * The localised sentence for a failure body carrying a known `code`, or null when it carries none
 * (every non-Spark engine) — the caller then shows the worker's own message.
 */
export function errorCodeText(t: (key: string) => string, body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const code = (body as { code?: unknown }).code
  return isSparkErrorCode(code) ? t(COPY_KEYS[code]) : null
}
