import type { PluginContext, PluginDefinition } from "../kernel/types"
import { createMemoryPersistence } from "./persistence"
import { deriveMessages } from "./projection"
import { SessionImpl } from "./session"
import type {
	CreateSessionOptions,
	DeleteSessionOptions,
	ListSessionsOptions,
	OpenSessionOptions,
	Session,
	SessionEvent,
	SessionExport,
	SessionPersistence,
	SessionService,
	SessionSummary,
} from "./types"

/**
 * Concrete implementation of the SessionService claimed by the sessions plugin.
 */
class SessionServiceImpl implements SessionService {
	private readonly ctx: PluginContext
	private readonly backends = new Map<string, SessionPersistence>()

	constructor(ctx: PluginContext) {
		this.ctx = ctx
		this.backends.set("memory", createMemoryPersistence())
	}

	registerBackend(name: string, backend: SessionPersistence): () => void {
		this.backends.set(name, backend)
		return () => {
			if (this.backends.get(name) === backend) {
				this.backends.delete(name)
			}
		}
	}

	getBackend(name?: string): SessionPersistence {
		const targetName = name || "memory"
		const backend = this.backends.get(targetName)
		if (!backend) {
			throw new Error(`Persistence backend "${targetName}" is not registered.`)
		}
		return backend
	}

	private createOnAppend(sessionId: string): (events: SessionEvent[]) => void {
		return (events: SessionEvent[]) => {
			this.ctx.events.emit("session/event", { sessionId, events })
		}
	}

	async create(options: CreateSessionOptions = {}): Promise<Session> {
		const id = options.id || crypto.randomUUID()
		const metadata = options.metadata ? { ...options.metadata } : {}
		const backend = this.getBackend(options.backend)

		await backend.create(id, metadata)
		const session = new SessionImpl(id, metadata, [], backend, this.createOnAppend(id))
		this.ctx.events.emit("session/created", { sessionId: id, metadata })
		return session
	}

	async open(id: string, options: OpenSessionOptions = {}): Promise<Session> {
		const backend = this.getBackend(options.backend)
		const events = await backend.open(id)
		const list = await backend.list()
		const metadata = list.find((s) => s.id === id)?.metadata || {}

		return new SessionImpl(id, metadata, events, backend, this.createOnAppend(id))
	}

	async list(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
		const backend = this.getBackend(options.backend)
		return await backend.list()
	}

	async delete(id: string, options: DeleteSessionOptions = {}): Promise<void> {
		const backend = this.getBackend(options.backend)
		await backend.delete(id)
		this.ctx.events.emit("session/deleted", { sessionId: id })
	}

	async import(data: SessionExport, options: OpenSessionOptions = {}): Promise<Session> {
		if (data.version !== 1) {
			throw new Error(`Unsupported session export version: ${data.version}`)
		}

		const backend = this.getBackend(options.backend)
		const metadata = data.metadata ? { ...data.metadata } : {}
		await backend.create(data.sessionId, metadata)
		if (data.events.length > 0) {
			await backend.append(data.sessionId, data.events)
		}

		const session = new SessionImpl(
			data.sessionId,
			metadata,
			data.events,
			backend,
			this.createOnAppend(data.sessionId),
		)
		this.ctx.events.emit("session/imported", { sessionId: data.sessionId })
		return session
	}

	deriveMessages(events: SessionEvent[]) {
		return deriveMessages(events)
	}
}

/**
 * Plugin that provides the v0.2 session subsystem by claiming ctx.sessions.
 */
export const sessionPlugin: PluginDefinition = {
	name: "sessions",
	setup(ctx: PluginContext) {
		const sessionService = new SessionServiceImpl(ctx)
		ctx.claim("sessions", sessionService)
	},
}
