import { runLiveSmoke } from './ai-live-smoke-lib.mjs'

process.exitCode = await runLiveSmoke()
