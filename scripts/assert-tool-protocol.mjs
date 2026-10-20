import assert from "node:assert/strict"

// Check the actual model input, not just whether the tool body returned success.
export function assertToolProtocol(messages) {
  const pending = new Set()
  for (const message of messages) {
    if (message.role === "tool") {
      assert.ok(pending.delete(message.toolCallId), `Unexpected tool result: ${message.toolCallId}`)
      continue
    }
    if (message.role === "assistant") {
      assert.equal(pending.size, 0, "Assistant message interrupts pending tool results")
      for (const block of message.content) {
        if (block.type !== "tool-call") continue
        assert.ok(!pending.has(block.id), `Duplicate tool call: ${block.id}`)
        pending.add(block.id)
      }
      continue
    }
    for (const block of message.content) {
      if (block.type === "tool-result") {
        assert.ok(pending.delete(block.toolCallId), `Unexpected tool result: ${block.toolCallId}`)
      } else {
        assert.equal(pending.size, 0, `Message ${message.source?.plugin ?? message.role} interrupts pending tool results: ${[...pending].join(", ")}`)
      }
    }
  }
  assert.equal(pending.size, 0, "The next model request must contain every tool result")
}
