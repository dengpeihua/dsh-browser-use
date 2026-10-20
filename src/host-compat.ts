import type { Session, SessionEvent } from "@deepseek-ai/dsh-session"
import type { SessionEventMap, SessionEventType, SurfaceEventType, SurfaceIntent } from "@deepseek-ai/dsh-session/types"
import type { Message } from "@deepseek-ai/dsh-llm"

/** DSH 0.2 uses flat tool-role messages and startSeq/endSeq surface bounds. */
export function modernSession(session: Session): boolean {
  return typeof (session as unknown as { snapshotEvents?: unknown }).snapshotEvents === "function"
}

export function legacyEvent(event: SessionEvent): SessionEvent {
  if (event.type !== "tool/result") return event
  const message = event.data.message as unknown as { role: string; content: unknown[]; isError?: boolean; toolCallId?: string; source: { callId: string } }
  if (message.role !== "tool") return event
  return {
    ...event,
    data: { ...event.data, message: {
      ...message, role: "user",
      content: [{ type: "tool-result", toolCallId: message.toolCallId ?? message.source.callId,
        ...(message.isError === undefined ? {} : { isError: message.isError }), content: message.content }],
    } },
  } as unknown as SessionEvent
}

export function hostMessage(session: Session, message: Message): Message {
  if (!modernSession(session)) return message
  const result = message.content[0]
  if (result?.type !== "tool-result") return message
  return { ...message, role: "tool", toolCallId: result.toolCallId,
    ...(result.isError === undefined ? {} : { isError: result.isError }), content: result.content } as unknown as Message
}

/** Preserve event provenance while translating only the host's wire representation. */
export const appendBrowserEvent = ((session: Session, type: string, data: unknown, intent?: unknown) => {
  if (!modernSession(session)) return Reflect.apply(session.append, session, [type, data, intent])
  let translated = data
  if (type === "tool/result") {
    const result = data as { message: Message }
    translated = { ...result, message: hostMessage(session, result.message) }
  }
  const placement = intent as { surfaceOp?: string | { op: string; start: number; end: number } } | undefined
  const op = placement?.surfaceOp
  const nextIntent = op && typeof op === "object"
    ? { ...placement, surfaceOp: { op: op.op, startSeq: op.start, endSeq: op.end } }
    : intent
  return Reflect.apply(session.append, session, [type, translated, nextIntent])
}) as <T extends SessionEventType>(
  session: Session, type: T, data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
) => SessionEvent<T>
