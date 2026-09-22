import { getPageDom, skippedDomOutput } from "../dom-utils.js"
import { EXTRACTION_GUIDE } from "../extraction-guide.js"
import { wrapScript } from "../page-tools.js"
import { throwIfBrowserAborted, type BrowserOperation } from "../runtime.js"

export const browserExecuteScript: BrowserOperation = {
  id: "browser_execute_script",
  description: `Read page data with JavaScript. Helpers: __data(type), __records(anchor), __skeleton(element), __q(N), __find(pattern), __get(ref), __clickable(element). Load guide: true before structured/list extraction. Retain important findings in text output before changing pages. Use browser action tools for interactions; returned elements serialize compactly.`,
  async execute(args, context) {
    const guide = args.guide === true ? EXTRACTION_GUIDE : ""
    if (!args.script) {
      if (!guide) throw new Error("Provide script or guide: true")
      return { title: "Extraction guide", output: guide, metadata: {} }
    }
    const script = String(args.script)
    const tab = context.manager.getActiveTab()
    const { resultText, dom, returnValue } = await context.manager.enqueue(async (isLast) => {
      throwIfBrowserAborted(context.signal)
      const visitId = tab.visitId
      const returnValue = await tab.domService.withClient(() => tab.domService.evaluateWithReturn(wrapScript(script)))
      const resultText = returnValue !== undefined ? `Result: ${JSON.stringify(returnValue)}` : "Script executed successfully"
      const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
      if (tab.visitId !== visitId) throw new Error("Page navigated during extraction; observe and extract again from a stable visit")
      return { resultText, dom, returnValue }
    }, context.signal)
    const limited = await context.outputLimiter.output(resultText)
    // Structured fields may be absent from rendered DOM. Archive the visible result
    // in the same observation so exact-evidence memory can retain it after navigation.
    const scriptEvidence = `\n\nScript extraction (untrusted data, captured before the accompanying DOM):\n${limited.content}\n`
    if (dom.observation) {
      dom.output += scriptEvidence
      dom.observation.output = dom.output
      dom.observation.fullOutput += scriptEvidence
      if (!limited.truncated && resultText.length <= 64000 && returnValue !== undefined) {
        dom.observation.extraction = returnValue
      }
    }
    return {
      title: "Execute script",
      output: `${guide ? guide + "\n\n" : ""}${dom.observation ? dom.output : limited.content + dom.output}`,
      observation: dom.observation,
      metadata: limited.truncated ? { scriptResultPath: limited.outputPath } : {},
    }
  },
}
