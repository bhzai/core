# Reference example plugins (`examples/`)

The `examples/` directory and `@bhzai/core/plugins/examples` contain working reference plugins that serve as fitness tests for the harness extension surface. Each plugin demonstrates real, production-quality code patterns using public kernel and harness APIs.

## Reference plugins

### Task-management plugin (`task-plugin.ts`)

A plugin implementing a per-session task list, showing:
- Standard `PluginDefinition` authoring
- Session event hooks (`session:start`, `turn:end`)
- Per-session state isolation
- Tool registration (`update_tasks` tool)
- Dynamic context injection into turns

### Agent-memory plugin (`memory-plugin.ts`)

A plugin implementing conversational memory extraction and recall, showing:
- Setup lifecycle hooks and service access
- Memory extraction during turn execution
- Session start memory recall with injection-defense framing
- Tool registration (`save_memory` tool)
- Pluggable backing store integration via `MemoryStore`

### RAG plugin (`rag-plugin.ts`)

A plugin implementing two retrieval shapes:
- **Agentic**: a `search_knowledge` tool the model calls on demand, querying registered knowledge sources.
- **Automatic**: turn start context injection — retrieves relevant context based on user input and injects a context block into the turn.

## Quickstart example (`readme-quickstart.ts`)

A runnable end-to-end example demonstrating:
1. Creating a harness with standard plugins (`sessionPlugin`, `llmPlugin`, `toolsPlugin`, `commandsPlugin`, `agentLoopPlugin`)
2. Registering an Ollama driver instance
3. Registering custom tools
4. Creating a session with a target model
5. Executing turns and disposing the harness

