/**
 * Base class for all runtime errors emitted by the v0.2 kernel.
 */
export class KernelError extends Error {
	/**
	 * Creates a new KernelError instance.
	 * @param message Descriptive error message.
	 */
	constructor(message: string) {
		super(message)
		this.name = new.target.name
	}
}

/**
 * Thrown when a plugin attempts to claim a service key that has already been claimed.
 */
export class ServiceAlreadyClaimedError extends KernelError {
	/** Name of the conflicting service key. */
	readonly serviceName: string

	/**
	 * Creates a new ServiceAlreadyClaimedError instance.
	 * @param serviceName The claimed service name.
	 */
	constructor(serviceName: string) {
		super(`Service "${serviceName}" is already claimed by another plugin.`)
		this.serviceName = serviceName
	}
}

/**
 * Thrown when a plugin declares a dependency that has not been loaded.
 */
export class MissingPluginDependencyError extends KernelError {
	/** Name of the plugin that requires the dependency. */
	readonly pluginName: string

	/** Name of the missing dependency. */
	readonly dependencyName: string

	/**
	 * Creates a new MissingPluginDependencyError instance.
	 * @param pluginName Name of the requesting plugin.
	 * @param dependencyName Name of the missing dependency.
	 */
	constructor(pluginName: string, dependencyName: string) {
		super(`Plugin "${pluginName}" requires missing dependency "${dependencyName}".`)
		this.pluginName = pluginName
		this.dependencyName = dependencyName
	}
}

/**
 * Thrown when circular dependencies are detected among plugins.
 */
export class CircularPluginDependencyError extends KernelError {
	/** The cycle path of plugin names. */
	readonly cycle: string[]

	/**
	 * Creates a new CircularPluginDependencyError instance.
	 * @param cycle Array of plugin names representing the cycle.
	 */
	constructor(cycle: string[]) {
		super(`Circular dependency detected among plugins: ${cycle.join(" -> ")}.`)
		this.cycle = cycle
	}
}

/**
 * Thrown when a plugin configuration fails JSON-Schema validation.
 */
export class InvalidPluginConfigError extends KernelError {
	/** Name of the misconfigured plugin. */
	readonly pluginName: string

	/** List of validation error details. */
	readonly validationErrors: string[]

	/**
	 * Creates a new InvalidPluginConfigError instance.
	 * @param pluginName Name of the plugin.
	 * @param validationErrors Array of validation failure messages.
	 */
	constructor(pluginName: string, validationErrors: string[]) {
		super(`Invalid configuration for plugin "${pluginName}": ${validationErrors.join("; ")}.`)
		this.pluginName = pluginName
		this.validationErrors = validationErrors
	}
}

/**
 * Thrown when an operation targets a plugin that is not registered.
 */
export class PluginNotFoundError extends KernelError {
	/** Name of the missing plugin. */
	readonly pluginName: string

	/**
	 * Creates a new PluginNotFoundError instance.
	 * @param pluginName Name of the missing plugin.
	 */
	constructor(pluginName: string) {
		super(`Plugin "${pluginName}" not found.`)
		this.pluginName = pluginName
	}
}
