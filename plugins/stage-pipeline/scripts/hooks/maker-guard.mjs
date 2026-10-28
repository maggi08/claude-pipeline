import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { readHookInput, pluginDataDir } from './pipeline-state.mjs'

/**
 * The maker does not finish until its hand-back is whole (VT-1 stage 11, K11.2-K11.4).
 *
 * Precedent: hand-backs of 16-18k characters, a `Changed:` list that did not match the tree, and maker items that reached the journal only when the orchestrator
 * copied them. SubagentStop of the `stage-implement` agent reads the hand-back from its transcript (the last `SubagentHandback` input, else the last assistant text)
 * and compares it with the tree against the snapshot agent-guard took at the spawn: a missing section, a hand-back over 4000 characters, a `Changed:` list that
 * disagrees with the files that changed, and — when the config has a `type_check` command — a checks line with no numbers are a reason to continue.
 * It blocks at most 3 times per agent (Claude Code's own cap is 8), then lets the stop through with a "hand-back not fixed" item for the digest.
 * A stop that goes through stores the blobs of the change set (git-guard compares the force commit with them) and the «Product-visible», «Not done / blocker»
 * and «ACs without implementation» items (`maker.mjs`).
 *
 * No snapshot for the session (a session that started before this version, a spawn the hooks never saw), a Force block that is old by the first-sight gates
 * (`makerRun`: a run already going when this version came), no transcript, or any error: the stop is not judged (fail open).
 */
const input = await readHookInput()
if (!/stage-implement$/.test(String(input.agent_type ?? ''))) process.exit(0)
const transcript = input.agent_transcript_path
if (typeof transcript !== 'string' || !transcript || !existsSync(transcript) || typeof input.session_id !== 'string' || !input.session_id) process.exit(0)

try {
  const { MAX_BLOCKS, blocksSoFar, changeSet, handbackProblems, makerRun, readHandback, readSnapshot, setBlocks, storeStop } = await import('../maker.mjs')
  const dataDir = pluginDataDir()
  const snapshot = readSnapshot(dataDir, input.session_id)
  const text = snapshot ? readHandback(transcript) : null
  if (!snapshot || text === null) process.exit(0)
  // Only under an open Force block that is new by the first-sight gates (D7): a run resumed after the release keeps the rules it started with.
  if (!snapshot.taskDir || !makerRun(dataDir, snapshot.taskDir)) process.exit(0)

  const changes = changeSet(snapshot)
  const problems = handbackProblems(text, snapshot, changes)
  const key = String(input.agent_id || basename(transcript))
  const blocked = blocksSoFar(dataDir, key)
  if (problems.length && blocked < MAX_BLOCKS) {
    setBlocks(dataDir, key, blocked + 1)
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason:
          `stage-pipeline: the hand-back is not whole (block ${blocked + 1} of ${MAX_BLOCKS}):\n${problems.map((line) => `- ${line}`).join('\n')}\n` +
          'Return it again by the contract of the stage-implement agent: `Changed:` (paths of the files that changed, the A/M/D prefix is allowed), `Decisions:`, `Product-visible:`, ' +
          '`lint / type_check / floor-guard:` (numbers against the baseline), `Not done / blocker:`, `ACs without implementation:` — up to 25 lines and 4000 characters. ' +
          'Do not edit files to fit the list: `Changed:` names the files that changed and that you wrote; a file you did not write goes under `Not done / blocker:` as `not mine: <path>`.',
      }),
    )
    process.exit(0)
  }
  storeStop(dataDir, snapshot, text, changes, { agent: String(input.agent_id ?? '') || null, unfixed: problems.length ? problems.join('; ') : null })
  setBlocks(dataDir, key, 0)
} catch {
  // a crash never holds the maker
}
process.exit(0)
