import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai'
import type { AgentCli, AgentCliEvent, AgentRunInput } from './types'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { readVersion, spawnJsonLines } from './process'

const READ_ONLY_TOOLS = 'read,grep,find,ls'

function args(input: AgentRunInput, sessionId: string): string[] {
  const list = [
    '--mode',
    'json',
    input.resume ? '--session' : '--session-id',
    input.resume ?? sessionId,
    '--name',
    'pulls.review',
    '--system-prompt',
    input.system,
    '--tools',
    READ_ONLY_TOOLS,
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-approve',
  ]
  if (input.sessionDir)
    list.push('--session-dir', input.sessionDir)
  if (input.model) {
    list.push('--model', input.model)
  }
  else if (process.env.PI_PROVIDER && process.env.PI_MODEL) {
    // A pulls.review process launched from Pi inherits the active provider/model.
    list.push('--provider', process.env.PI_PROVIDER, '--model', process.env.PI_MODEL)
  }
  return list
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  const message = record(value)
  return message?.role === 'assistant' && Array.isArray(message.content)
}

function isToolResultMessage(value: unknown): value is ToolResultMessage {
  const message = record(value)
  return message?.role === 'toolResult' && Array.isArray(message.content)
}

function textOf(message: AssistantMessage): string | undefined {
  const text = message.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('')
  return text || undefined
}

function modelOf(message: AssistantMessage): string | undefined {
  return message.provider && message.model ? `${message.provider}/${message.model}` : message.model
}

interface PiRunState {
  session?: string
  model?: string
  finalText?: string
  finalError?: string
  finalSent: boolean
}

function finalEvent(state: PiRunState): AgentCliEvent {
  return { kind: 'final', text: state.finalError ?? state.finalText, isError: state.finalError !== undefined }
}

function isLostSession(stderr: string): boolean {
  return /session.*not found/i.test(stderr) || /no session found/i.test(stderr) || /session.*does not exist/i.test(stderr) || /session found in different project/i.test(stderr)
}

function messageEvents(value: unknown, state: PiRunState): AgentCliEvent[] {
  if (isToolResultMessage(value))
    return [{ kind: 'message', message: value }]
  if (!isAssistantMessage(value))
    return []

  const events: AgentCliEvent[] = [{ kind: 'message', message: value }]
  const model = modelOf(value)
  if (state.session && model && model !== state.model) {
    state.model = model
    events.push({ kind: 'session', id: state.session, model })
  }
  const text = textOf(value)
  if (text)
    state.finalText = text
  if (value.stopReason === 'error' || value.stopReason === 'aborted')
    state.finalError = value.errorMessage ?? text ?? `Pi stopped: ${value.stopReason}`
  return events
}

function lineEvents(value: unknown, state: PiRunState): AgentCliEvent[] {
  const line = record(value)
  if (!line || typeof line.type !== 'string')
    return []
  if (line.type === 'session' && typeof line.id === 'string') {
    state.session = line.id
    return [{ kind: 'session', id: line.id }]
  }
  if (line.type === 'message_end')
    return messageEvents(line.message, state)
  if (line.type === 'agent_settled' && !state.finalSent) {
    state.finalSent = true
    return [finalEvent(state)]
  }
  return []
}

/** Pi's JSON mode uses the user's existing Pi model configuration and credentials. */
export const pi: AgentCli = {
  name: 'pi',
  label: 'Pi',
  detect: () => readVersion('pi'),
  models: async () => [],
  async* run(input: AgentRunInput): AsyncGenerator<AgentCliEvent> {
    const state: PiRunState = { session: input.resume, finalSent: false }
    const sessionId = randomUUID()
    for await (const item of spawnJsonLines('pi', args(input, sessionId), { cwd: input.cwd, signal: input.signal, stdin: input.prompt })) {
      if ('line' in item) {
        yield* lineEvents(item.line, state)
        continue
      }
      if (!state.finalSent && (state.finalText !== undefined || state.finalError !== undefined))
        yield finalEvent(state)
      yield {
        kind: 'exit',
        ...item.exit,
        sessionLost: isLostSession(item.exit.stderr),
      }
    }
  },
}
