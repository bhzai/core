import type { BHZAIDriver } from "../types/driver"
import type { ModelInfo } from "../types/model"
import { AmbiguousModelError, DriverNotFoundError, ModelNotFoundError } from "./errors"
import type { ResolvedModel } from "./types"

/**
 * Parses a qualified model reference ('<driver>/<model>') into driver and model parts.
 * @param ref The reference string to parse.
 * @returns Object with driver and id, or null if ref is not qualified with a slash.
 */
export function parseModelRef(ref: string): { driver: string; id: string } | null {
	const slashIndex = ref.indexOf("/")
	if (slashIndex < 0) return null
	return {
		driver: ref.slice(0, slashIndex),
		id: ref.slice(slashIndex + 1),
	}
}

/**
 * Merges models across all provided drivers.
 * @param drivers Iterable of active BHZAIDriver implementations.
 * @returns Aggregated list of ModelInfo records.
 */
export async function mergeDriverCatalogues(drivers: Iterable<BHZAIDriver>): Promise<ModelInfo[]> {
	const results: ModelInfo[] = []
	const seenRefs = new Set<string>()

	for (const driver of drivers) {
		try {
			const models = await driver.listModels()
			for (const m of models) {
				const qualifiedRef = m.ref || `${driver.id}/${m.id}`
				if (!seenRefs.has(qualifiedRef)) {
					seenRefs.add(qualifiedRef)
					results.push({
						...m,
						driver: driver.id,
						ref: qualifiedRef,
					})
				}
			}
		} catch {
			// Offline or probing driver error does not prevent other catalogues from loading
		}
	}

	return results
}

/**
 * Resolves a model reference against registered drivers and their model catalogues.
 * @param ref The model identifier or qualified reference.
 * @param drivers Map of registered drivers keyed by id.
 * @param catalogue Aggregated model catalogue.
 * @returns ResolvedModel descriptor.
 */
export function resolveModel(
	ref: string,
	drivers: Map<string, BHZAIDriver>,
	catalogue: ModelInfo[],
): ResolvedModel {
	const parsed = parseModelRef(ref)

	if (parsed) {
		const driver = drivers.get(parsed.driver)
		if (!driver) {
			throw new DriverNotFoundError(parsed.driver)
		}
		const matching = catalogue.find((m) => m.ref === ref)
		if (catalogue.length > 0 && !matching) {
			// Check if driver claims this model directly even if listModels() did not list it
			const driverModels = catalogue.filter((m) => m.driver === parsed.driver)
			if (driverModels.length > 0 && !driverModels.some((m) => m.id === parsed.id)) {
				throw new ModelNotFoundError(ref)
			}
		}
		return {
			driver,
			model: parsed.id,
			qualifiedRef: ref,
		}
	}

	// Bare ID resolution
	const matches = catalogue.filter((m) => m.id === ref)
	if (matches.length === 1) {
		const match = matches[0]
		const driver = drivers.get(match.driver)
		if (!driver) throw new DriverNotFoundError(match.driver)
		return {
			driver,
			model: match.id,
			qualifiedRef: match.ref,
		}
	}

	if (matches.length > 1) {
		throw new AmbiguousModelError(
			ref,
			matches.map((m) => m.ref),
		)
	}

	// If no matches in catalogue, check registered drivers directly
	const activeDrivers = Array.from(drivers.values())
	if (activeDrivers.length === 1) {
		return {
			driver: activeDrivers[0],
			model: ref,
			qualifiedRef: `${activeDrivers[0].id}/${ref}`,
		}
	}

	throw new ModelNotFoundError(ref)
}
