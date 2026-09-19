# Profile activity surface design

**Date:** 2026-09-19
**Status:** Revised for review

## Intent

Produce a privacy-preserving 30-day Codex activity surface. MacBook and Mac mini collect only their own local activity on separate schedules and update separate sanitized collection files in the repository. The renderer combines those two collections only at visualization time. Account-wide Codex limits remain a separate account scope and are never added once per device.

The rendered surface shows usage shape without exposing plugin names, skill names, prompts, responses, tool arguments, paths, task identifiers, source identifiers, model names, or a per-device breakdown. The two explicitly named repository collection files expose only their own anonymous aggregate inputs.

## Success criteria

- Each device independently produces one validated local snapshot and one sanitized repository collection covering the latest 30 KST dates.
- Each device updates only its own repository collection.
- Visualization combines the two current collections without collecting either device again.
- Every retained field is a count, duration, fixed category, percentage input, or availability marker.
- Plugin and skill identities are reduced in memory and never persist in snapshots, repository collections, diagnostics, or rendered artifacts.
- Missing structured telemetry remains `null`; it never becomes zero or an inferred value.
- Current account usage can be sampled through the native Codex interface without duplicating it across devices.
- Existing merged public output remains unchanged until both repository collections use the new schema and the enriched public surface is separately verified.

## Non-goals

- Ranking or publishing individual plugins, skills, models, repositories, tasks, or devices
- Reading prompt, response, or tool-argument content to infer activity
- Reconstructing historical account quota before the first native sample
- Treating a README SVG as an interactive dashboard
- Adding a database, dependency, network service, shared folder, or task-to-task relay
- Changing installed runtimes, private configuration, automation, or pending delivery state as part of source implementation

## Data sources

### Device-local structured telemetry

The installed collector parses local Codex JSONL mechanically. The model never reads or interprets raw records. The parser accepts only documented structural fields and immediately reduces them to counters.

The collector may use:

- session identity only for in-memory and cache deduplication;
- event timestamps for KST day assignment and observed chat span;
- cumulative token telemetry for positive token deltas;
- explicit tool-call type and name for fixed-family classification;
- explicit skill-use, mode, and reasoning fields when those structured events exist.

The collector must not infer skill use, mode, or reasoning from prompts, responses, file paths, shell commands, or tool arguments.

### Account-wide native usage

The Codex native usage interface supplies a current account snapshot, including available usage windows, used percentage, reset time, rate-limit state, and credit availability. This data is account-scoped, not device-scoped.

The publisher-side fixed task samples it once per scheduled processing cycle and passes an exact sanitized object to the installed runtime. Historical quota data begins with the first successful sample; unavailable earlier dates remain `null`.

## Private device snapshot

Introduce private schema v3 while retaining v2 parsing during migration. A v3 snapshot keeps the policy, revision, collection time, timezone, window, and daily activity fields, but removes source identity. The installed config binds the local collection slot to its fixed repository filename; that binding is never serialized in the JSON body. Its window contains exactly 30 KST dates.

Each day adds this anonymous surface:

```json
{
  "date": "YYYY-MM-DD",
  "active": true,
  "activeSessions": 0,
  "newChats": 0,
  "toolCalls": 0,
  "pluginCalls": 0,
  "skillUses": null,
  "tokens": 0,
  "maxSessionTokens": 0,
  "longestSessionMinutes": 0,
  "fastTurns": null,
  "modeTurns": null,
  "reasoningTurns": null,
  "reasoning": null,
  "coverage": "complete"
}
```

`reasoning`, when available, contains counts for a fixed non-identifying set: `none`, `low`, `medium`, `high`, `xhigh`, and `other`. Percentages are derived only during processing. `fastTurns` uses `modeTurns` as its denominator. `reasoningTurns` is the sum validated against the fixed reasoning counters.

`newChats` counts a logical session once and assigns it to the first observed active date inside the window. Session identifiers remain only in the private incremental cache and never enter a snapshot or repository collection.

`pluginCalls` counts calls that carry an explicit plugin identity. The identity is discarded after classification. `skillUses` counts only explicit structured skill activation events. If the runtime does not expose those events, the value is `null` for that source and date.

## Anonymous classification

The collector reduces tool identities to fixed counters before persistence:

- total tool calls;
- plugin calls;
- browser or web calls;
- computer-use calls;
- other structured tool calls.

No stable hash, opaque plugin identifier, skill name, top-N list, or rare-category label is retained. This avoids recreating a workflow fingerprint while still preserving the activity silhouette.

Classification rules are exact allowlisted prefixes or event types. Unknown tool shapes increase the total only when they satisfy the existing tool-call contract; otherwise their metric becomes unavailable rather than being guessed.

## Repository collections

The repository stores two sanitized collection surfaces:

- `metrics/codex-activity-macbook.json`
- `metrics/codex-activity-macmini.json`

These are public collection inputs, not private device snapshots. Their fixed filenames bind the collection slot; their JSON bodies contain no source or device identifier and no stable digest. Each file contains only the validated anonymous 30-day schema v3 surface described above.

MacBook may update only the MacBook collection, and Mac mini may update only the Mac mini collection. Their schedules are non-overlapping. Before publishing, each device fetches the latest remote state, replaces only its collection, and runs visualization against both repository collections. A non-fast-forward update re-fetches and recomputes from the new remote state within the existing bounded retry policy; it never force-pushes.

No envelope, receive, acknowledgement, shared transport directory, or task-to-task payload participates in the active workflow. Existing relay state is ignored during rollout and is not migrated into a repository collection.

## Processing and merge rules

Visualization reads the two repository collections. It never invokes collection.

- Additive counters are summed when both device values are known.
- `maxSessionTokens` and `longestSessionMinutes` use the maximum.
- `fastTurns`, `modeTurns`, reasoning counters, and reasoning denominators are summed before calculating percentages.
- Optional metrics remain `null` unless both sources provide compatible structured coverage.
- Streaks derive from the merged daily `active` values.
- Account usage is joined once after device merge and is never summed.
- A stale, missing, conflicting, or mixed-schema collection preserves the last merged public result while still allowing the current device to publish its own valid collection.

During migration, schema v2 snapshots continue to support the existing public activity output. The enriched surface becomes publishable only when both current repository collections are schema v3.

## Account usage snapshot

The account snapshot contains only:

- observation time;
- usage window duration;
- used percentage;
- reset time;
- rate-limit state;
- credit availability and unlimited flags;
- sample coverage.

It excludes account identifiers, plan identifiers, balances, reset-credit identifiers, titles, descriptions, and raw native responses. A balance is intentionally excluded because it can reveal billing information and is not needed for an activity silhouette.

Account samples are stored privately. Public exposure of quota percentages or reset times is outside this change and requires a separate explicit decision.

## Public surface

The enriched public schema contains anonymous 30-day data only:

- total tokens;
- maximum session tokens;
- longest observed chat span;
- active days and current/longest streak;
- session-days and new chats;
- total tool, plugin, browser/web, computer-use, and other tool calls;
- total skill uses when structurally available;
- Fast mode percentage when structurally available;
- reasoning percentages over the fixed reasoning categories when structurally available;
- daily values for the same anonymous counters.

The merged output contains no per-device breakdown, top-N list, stable category identifier, or plugin/skill name. The two repository collection files remain separate anonymous inputs as explicitly selected by the user; the generated SVG exposes only their merged result and remains static. Interactive daily, weekly, and cumulative controls are not part of a README artifact.

## Failure and diagnostic behavior

- Schema, range, denominator, and exact-key validation occurs before persistence.
- A malformed optional metric makes that metric unavailable; it does not silently corrupt existing core activity counts.
- Raw subprocess output is sanitized immediately using the existing structured failure contract.
- Diagnostics report only stage, exit code, signal, error class, sanitized stderr class, state-change state, and metric availability.
- Diagnostics never contain snapshot bodies, account values, identifiers, names, paths, or device-specific figures.
- No automatic collection retry follows a failed state-changing command without new direct user approval. The existing bounded Git non-fast-forward retry re-fetches and recomputes the same approved publication attempt without recollecting.

## Verification

Node tests must cover:

1. 30-day v3 device snapshots with exact schemas and bounds;
2. unique-chat counting without persisting session identifiers;
3. plugin and tool-family classification without retained names;
4. explicit skill-use, Fast mode, and reasoning events;
5. unavailable optional metrics when structured events do not exist;
6. weighted percentage aggregation across two independent sources;
7. account usage sanitization and rejection of identifiers, balances, and extra keys;
8. v2 compatibility and v3-only enriched publication;
9. each device updating only its own repository collection;
10. visualization-only merge without collection or relay calls;
11. absence of private canaries from snapshots, collection files, diagnostics, and public output;
12. preservation of the last merged public result on missing, stale, conflicting, or malformed input;
13. safe recomputation after a non-fast-forward repository update.

The repository check remains:

```sh
node --test tests/profile-activity/*.test.mjs
```

No test may read real Codex JSONL, write installed state, execute an actual repository publication, or publish generated files.

## Rollout

1. Implement schema v3 and synthetic tests in repository source.
2. Verify structure-only telemetry support for skill, mode, and reasoning fields without printing values.
3. Replace the active relay path with per-device repository collection publication.
4. Install one approved v3 runtime on each device only after source review.
5. Keep device collection schedules separate and non-overlapping.
6. Let each device publish only its own sanitized collection once.
7. Verify one visualization-only merge and private account sample.
8. Enable enriched merged output only after privacy review and a two-collection preview.

Rollback restores the previous installed runtime and leaves existing v2 snapshots and the last public result intact. It never deletes raw logs, private snapshots, or delivery state.
