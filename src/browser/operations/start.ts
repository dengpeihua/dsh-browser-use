import { getPageDom, skippedDomOutput } from "../dom-utils.js"
import { navigatePage, type BrowserOperation } from "../runtime.js"

export const BROWSER_GUIDE = `# Browser Mode

The DSH browser plugin controls a real Chromium instance isolated to the current Agent Session.

- DOM markers \`[N]\` are clickable and \`<N>\` are inputs.
- Match element labels or nearby text, and use DOM indentation to distinguish parents, children, and siblings; do not choose by marker order alone.
- Use only markers valid in the current DOM state. After navigation or a changed snapshot, inspect the updated DOM instead of guessing or reusing stale indices.
- Elements in \`=== OFF-SCREEN ... ===\` blocks are not currently visible. Use \`browser_reveal_offscreen\` with their \`[container:N]\` and optional \`target\`, then interact using the refreshed DOM.
- Visual markers \`[view:ID]\` can be inspected with \`browser_view_elements\`.
- Use the container index from \`[container:N]\` with the scroll tools.
- The host keeps the current DOM and required baselines while older observations remain recallable from the Session log. Pending archived observations never block browsing.
- Prefer \`browser_click\` and \`browser_input\`; use \`browser_execute_script\` for targeted inspection.
- Call \`browser_restore_state\` with the exact versioned stateId to restore supported form and scroll state. Inspect restoration failures and omissions; arbitrary SPA memory is not restored.
- Scroll coverage is tied to captured DOM content and layout, not a count of all data items. Dynamic changes invalidate old coverage; record item identities when completeness matters.
- A successful tool call is not task completion. Click/input accept expectText and expectUrl postconditions; inspect verification metadata, error and partial results before continuing.

## Decision Process

1. Review the user's task and current goal
2. Analyze the current page DOM to see what elements are available
3. **Record important information in your text output before taking actions that change the page** — the current DOM snapshot will be replaced after your next action. Any unrecorded data is lost. Write down answers, clues, navigation waypoints, or any useful observations before proceeding.
4. Prefer targeted actions (filters, sorting, dropdowns) over browsing items one by one
5. Execute the next action based on your reasoning`

export const browserStart: BrowserOperation = {
  id: "browser_start",
  description: "Start the Session-isolated Chromium browser, navigate to a URL, and return the usage guide plus a DOM snapshot.",
  async execute(args, context) {
    const url = String(args.url)
    return context.manager.enqueue(async (isLast) => {
      const tab = context.manager.hasActiveTab() ? context.manager.getActiveTab() : await context.manager.newTab()
      const finalUrl = await navigatePage(tab, url, context.signal)
      const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
      const guide = context.manager.consumeGuide() ? `${BROWSER_GUIDE}\n\n---\n\n` : ""
      return {
        title: `Browser started → ${finalUrl}`,
        output: `${guide}Navigated to ${finalUrl}${dom.output}`,
        observation: dom.observation,
        metadata: { url: finalUrl, domId: dom.domId },
      }
    }, context.signal)
  },
}
