import type {
	BailHandler,
	Disposable,
	EventBus,
	NotificationHandler,
	WaterfallHandler,
} from "./types"

/**
 * Implementation of the unified EventBus supporting emit, serial, waterfall, and bail modes.
 */
class EventBusImpl implements EventBus {
	private readonly notifications = new Map<string, Set<NotificationHandler<unknown>>>()
	private readonly waterfalls = new Map<string, WaterfallHandler<unknown, unknown>[]>()
	private readonly bails = new Map<string, BailHandler<unknown, unknown>[]>()

	on<T = unknown>(event: string, handler: NotificationHandler<T>): Disposable {
		let set = this.notifications.get(event)
		if (!set) {
			set = new Set()
			this.notifications.set(event, set)
		}
		const untyped = handler as NotificationHandler<unknown>
		set.add(untyped)
		return () => {
			set?.delete(untyped)
			if (set?.size === 0) {
				this.notifications.delete(event)
			}
		}
	}

	waterfall<T = unknown, TCtx = unknown>(
		event: string,
		handler: WaterfallHandler<T, TCtx>,
	): Disposable {
		let list = this.waterfalls.get(event)
		if (!list) {
			list = []
			this.waterfalls.set(event, list)
		}
		const untyped = handler as WaterfallHandler<unknown, unknown>
		list.push(untyped)
		return () => {
			const current = this.waterfalls.get(event)
			if (current) {
				const idx = current.indexOf(untyped)
				if (idx !== -1) current.splice(idx, 1)
				if (current.length === 0) this.waterfalls.delete(event)
			}
		}
	}

	bail<T = unknown, TResult = unknown>(
		event: string,
		handler: BailHandler<T, TResult>,
	): Disposable {
		let list = this.bails.get(event)
		if (!list) {
			list = []
			this.bails.set(event, list)
		}
		const untyped = handler as BailHandler<unknown, unknown>
		list.push(untyped)
		return () => {
			const current = this.bails.get(event)
			if (current) {
				const idx = current.indexOf(untyped)
				if (idx !== -1) current.splice(idx, 1)
				if (current.length === 0) this.bails.delete(event)
			}
		}
	}

	emit<T = unknown>(event: string, payload: T): void {
		const set = this.notifications.get(event)
		if (!set || set.size === 0) return
		const listeners = [...set]
		for (const listener of listeners) {
			try {
				const result = listener(payload)
				if (result && typeof (result as Promise<void>).catch === "function") {
					;(result as Promise<void>).catch((err: unknown) => {
						console.error(`[EventBus] Unhandled error in emit handler for "${event}":`, err)
					})
				}
			} catch (err: unknown) {
				console.error(`[EventBus] Synchronous error in emit handler for "${event}":`, err)
			}
		}
	}

	async runSerial<T = unknown>(event: string, payload: T): Promise<void> {
		const set = this.notifications.get(event)
		if (!set || set.size === 0) return
		const listeners = [...set]
		for (const listener of listeners) {
			await listener(payload)
		}
	}

	async runWaterfall<T = unknown, TCtx = unknown>(
		event: string,
		initialValue: T,
		context: TCtx,
	): Promise<T> {
		const list = this.waterfalls.get(event)
		if (!list || list.length === 0) return initialValue
		const handlers = [...list]
		let index = 0

		const dispatch = async (currentValue: unknown): Promise<unknown> => {
			if (index >= handlers.length) return currentValue
			const handler = handlers[index++]
			return await handler(currentValue, context, dispatch)
		}

		return (await dispatch(initialValue)) as T
	}

	async runBail<T = unknown, TResult = unknown>(
		event: string,
		payload: T,
	): Promise<TResult | undefined> {
		const list = this.bails.get(event)
		if (!list || list.length === 0) return undefined
		const handlers = [...list]
		for (const handler of handlers) {
			const result = await handler(payload)
			if (result !== undefined) {
				return result as TResult
			}
		}
		return undefined
	}

	clear(): void {
		this.notifications.clear()
		this.waterfalls.clear()
		this.bails.clear()
	}
}

/**
 * Creates a new unified EventBus instance supporting emit, serial, waterfall, and bail modes.
 * @returns An initialized EventBus implementation.
 */
export function createEventBus(): EventBus {
	return new EventBusImpl()
}
