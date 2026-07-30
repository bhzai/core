/**
 * @file Thin wrapper around `toastify-js` for surfacing transient errors.
 *
 * Example-only — `toastify-js` is never imported from the BHZAI package. The
 * CSS is imported as a side-effect so the toast styling ships with the bundle.
 */

import Toastify from "toastify-js"
import "toastify-js/src/toastify.css"

/**
 * Show a transient error toast in the top-right corner.
 *
 * Uses the `--warm` token for the background so it reads as an error in the
 * dark theme.
 *
 * @param message - The error text to display
 */
export function showErrorToast(message: string): void {
	Toastify({
		text: message,
		gravity: "top",
		position: "right",
		style: { background: "var(--warm)" },
	}).showToast()
}
