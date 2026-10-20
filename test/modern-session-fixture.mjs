import assert from "node:assert/strict"

// Exercise the 0.2 wire contract while storing events in the locked 0.1 Session.
// scripts/smoke-host.mjs also runs against actual published hosts.
export function snapshotSession(session) {
  return new Proxy(session, {
    get(target, key) {
      if (key === "events") throw new Error("Current hosts do not expose Session.events")
      if (key === "snapshotEvents") return () => target.events.map(event => {
        if (event.type !== "tool/result") return event
        const result = event.data.message.content[0]
        return { ...event, data: { ...event.data, message: {
          ...event.data.message, role: "tool", toolCallId: result.toolCallId,
          ...(result.isError === undefined ? {} : { isError: result.isError }), content: result.content,
        } } }
      })
      if (key === "append") return (type, data, intent) => {
        if (type === "tool/result") {
          assert.equal(data.message.role, "tool")
          const message = data.message
          data = { ...data, message: { ...message, role: "user", content: [{
            type: "tool-result", toolCallId: message.toolCallId,
            ...(message.isError === undefined ? {} : { isError: message.isError }), content: message.content,
          }] } }
          delete data.message.toolCallId
          delete data.message.isError
        }
        if (intent && typeof intent.surfaceOp === "object") {
          const op = intent.surfaceOp
          assert.equal(typeof op.startSeq, "number")
          assert.equal(typeof op.endSeq, "number")
          intent = { ...intent, surfaceOp: { op: op.op, start: op.startSeq, end: op.endSeq } }
        }
        return target.append(type, data, intent)
      }
      const value = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
