# Public WebVoyager archive

This directory is a publication copy of the local 549-task WebVoyager run. The original local run, including its historical attempts and trajectories, was not edited for publication.

The source `results.ndjson`, `result-revisions/`, task attempt directories, manifest, scores, metrics, and strict review export remain in place. The review in `reference-review-20260928/` reuses the 549 existing reference judgments and records 12 explicit strict-condition corrections; it did not rerun the browser or call the model.

Before publication, local user-directory path prefixes in 71 files were replaced with `<USER_HOME>`. Google Maps API key values appearing in page evidence were replaced with `[REDACTED_GOOGLE_API_KEY]` in 6 files (100 occurrences). These changes affect public copies of some logs, launcher scripts, traces, and sessions; they do not change task IDs, answers, judgments, costs, or revision-chain result records. The files should be treated as public browser evidence, which may contain page-visible names and contact details.

The archive was checked for high-confidence API key prefixes, private-key headers, Bearer values, authorization and cookie JSON fields, local absolute paths, file sizes, and the 549-task result revision chain. The remaining `sk-` prefix matches were public page URLs or DOM identifiers. No single file exceeded GitHub's 100 MB Git file limit.
