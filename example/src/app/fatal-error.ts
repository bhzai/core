/** @file The one path that blocks all interaction. */

import type { BhzaiComposer } from "../components/composer.js"
import type { BhzaiTelemetry } from "../components/telemetry-panel.js"

/**
 * Display an error that makes the demo unusable, and take the composer away so
 * the user is not invited to type into something that cannot answer.
 *
 * Lives outside both components because it is the one place that spans them:
 * neither the telemetry rail nor the composer should know the other exists.
 *
 * @param message - What went wrong, in the user's terms
 * @param ui - The two custom elements this affects
 */
export function showFatalError(
	message: string,
	ui: { telemetry: BhzaiTelemetry; composer: BhzaiComposer },
): void {
	ui.telemetry.showMessage(message)
	ui.composer.hide()
}
