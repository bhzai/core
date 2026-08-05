/** @file Formatting utilities for display of numeric values. */

/**
 * Formats a tokens-per-second rate for display.
 *
 * Returns a one-decimal-place string (e.g., "42.1"), or an em dash ("—") for null/undefined input.
 *
 * @param n - Tokens per second, or null/undefined for no data
 * @returns Formatted rate or em dash placeholder
 */
export function formatTps(n: number | null | undefined): string {
	if (n === null || n === undefined) {
		return "—"
	}
	return n.toFixed(1)
}

/**
 * Formats a token count with thousands separators.
 *
 * Returns a string like "12,345" for large numbers, "0" for zero.
 *
 * @param n - Token count
 * @returns Thousands-separated integer string
 */
export function formatTokens(n: number): string {
	return Math.floor(n).toLocaleString("en-US")
}

/**
 * Formats a byte count as human-readable binary units.
 *
 * Uses 1024-based units (KB, MB, GB) with one decimal place.
 * Values < 1024 are shown as "N B".
 *
 * @param n - Byte count
 * @returns Human-readable byte string, e.g., "1.5 KB"
 */
export function formatBytes(n: number): string {
	if (n < 1024) {
		return `${Math.floor(n)} B`
	}
	if (n < 1024 * 1024) {
		return `${(n / 1024).toFixed(1)} KB`
	}
	if (n < 1024 * 1024 * 1024) {
		return `${(n / (1024 * 1024)).toFixed(1)} MB`
	}
	return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Formats a duration in seconds for display.
 *
 * Returns a string with one decimal place, e.g., "0.4s" or "12.3s".
 *
 * @param s - Duration in seconds
 * @returns Formatted seconds string
 */
export function formatSeconds(s: number): string {
	return `${s.toFixed(1)}s`
}

/**
 * Formats a timestamp as a short relative-time string.
 *
 * Returns "just now", "Nm", "Nh", "Nd", or a short date for older entries.
 *
 * @param timestamp - Milliseconds since epoch
 * @returns Human-readable relative time
 */
export function formatRelativeTime(timestamp: number): string {
	const now = Date.now()
	const diff = now - timestamp
	const seconds = Math.floor(diff / 1000)
	const minutes = Math.floor(seconds / 60)
	const hours = Math.floor(minutes / 60)
	const days = Math.floor(hours / 24)

	if (seconds < 60) return "just now"
	if (minutes < 60) return `${minutes}m`
	if (hours < 24) return `${hours}h`
	if (days < 7) return `${days}d`
	return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}
