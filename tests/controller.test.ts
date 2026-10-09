import { describe, expect, test } from 'claude-code/testing'

import type { DevtoolsSettings } from '../types'
import { parseBreakpointSpec } from '../src/core/breakpoints.ts'
import {
  classifyResult,
  DISARMED,
  interpretAnswer,
  LABELS,
  pauseQuestion,
  planAfterError,
  planCall,
  refusalText,
  wouldPause,
} from '../src/core/controller.ts'
import { classifyRisk, normalizeCall } from '../src/core/events.ts'
import { checkSimulation, SIMULATED_FAILURE_TAG, SIMULATED_OUTPUT_TAG, synthesize } from '../src/core/simulation.ts'

function settings(mode: DevtoolsSettings['mode'], ...specs: string[]): DevtoolsSettings {
  return {
    mode,
    recording: true,
    breakpoints: specs.map((spec, i) => {
      const parsed = parseBreakpointSpec(spec, `bp${i + 1}`, 'all')
      if (!parsed.ok) throw new Error(parsed.error)
      return parsed.breakpoint
    }),
  }
}

const bash = (command: string) => normalizeCall({ tool: 'Bash', tool_use_id: 'b', command })
const ask = normalizeCall({ tool: 'AskUserQuestion', tool_use_id: 'q', questions: [] })

describe('planning a call', () => {
  test('active mode pauses on a matching pause rule and counts the hit', () => {
    const planned = planCall(settings('active', 'command npm install'), DISARMED, bash('npm install x'))
    expect(planned.plan.kind).toBe('pause')
    expect(planned.settings.breakpoints[0]?.hitCount).toBe(1)
  })

  test('a non-matching rule leaves the call alone', () => {
    const before = settings('active', 'command npm install')
    const planned = planCall(before, DISARMED, bash('npm test'))
    expect(planned.plan.kind).toBe('pass')
    expect(planned.settings).toBe(before)
  })

  test('observe mode records what would pause and never pauses', () => {
    const planned = planCall(settings('observe', 'tool Bash'), { pauseNext: true, step: false }, bash('ls'))
    expect(planned.plan.kind).toBe('record')
    expect(planned.arm.pauseNext).toBe(true)
  })

  test('off mode does nothing at all', () => {
    const before = settings('off', 'tool Bash')
    const planned = planCall(before, { pauseNext: true, step: false }, bash('ls'))
    expect(planned.plan).toEqual({ kind: 'pass' })
    expect(planned.settings).toBe(before)
  })

  test('warn and record actions do not pause', () => {
    expect(planCall(settings('active', 'tool Bash --action warn'), DISARMED, bash('ls')).plan.kind).toBe('warn')
    expect(planCall(settings('active', 'tool Bash --action record'), DISARMED, bash('ls')).plan.kind).toBe('record')
  })

  test('stepping pauses the next call once, and never a question', () => {
    const armed = { pauseNext: false, step: true }
    const first = planCall(settings('active'), armed, bash('ls'))
    expect(first.plan).toMatchObject({ kind: 'pause', reason: 'step' })
    expect(first.arm).toEqual(DISARMED)
    expect(planCall(settings('active'), first.arm, bash('ls')).plan.kind).toBe('pass')
    const skipped = planCall(settings('active'), armed, ask)
    expect(skipped.plan.kind).toBe('pass')
    expect(skipped.arm).toBe(armed)
  })

  test('an unchanged arm keeps its identity, so no state write is needed', () => {
    const arm = { pauseNext: false, step: false }
    expect(planCall(settings('active', 'tool Bash'), arm, bash('ls')).arm).toBe(arm)
    expect(planCall(settings('active'), arm, bash('ls')).arm).toBe(arm)
  })

  test('an error rule with pause arms the next call; it never pauses the failed one', () => {
    const after = planAfterError(settings('active', 'error Bash --action pause'), DISARMED, bash('npm test'))
    expect(after.triggered).toHaveLength(1)
    expect(after.arm).toMatchObject({ pauseNext: true, reason: 'after Bash failed' })
    const warnOnly = planAfterError(settings('active', 'error'), DISARMED, bash('npm test'))
    expect(warnOnly.triggered).toHaveLength(1)
    expect(warnOnly.arm).toEqual(DISARMED)
  })

  test('wouldPause judges from a snapshot, for the fail-closed handler', () => {
    expect(wouldPause(settings('active', 'command rm -rf'), DISARMED, bash('rm -rf build'))).toBe(true)
    expect(wouldPause(settings('active', 'command rm -rf'), DISARMED, bash('ls'))).toBe(false)
    expect(wouldPause(settings('observe', 'command rm -rf'), DISARMED, bash('rm -rf build'))).toBe(false)
    expect(wouldPause(undefined, undefined, bash('rm -rf build'))).toBe(false)
  })
})

describe('the pause dialog', () => {
  test('offers Continue, Step, Reject, and Simulate only when allowed', () => {
    const base = { tool: 'Bash', summary: 'npm i', reason: 'breakpoint "x"', risk: 'network' as const }
    expect(pauseQuestion({ ...base, canSimulate: false }).options).toEqual(['Continue', 'Step', 'Reject'])
    const question = pauseQuestion({ ...base, canSimulate: true, permission: { decision: 'ask', rule: 'Bash(npm:*)', source: 'preview' } })
    expect(question.options).toEqual(['Continue', 'Step', 'Reject', 'Simulate'])
    expect(question.question).toContain('permission ask by Bash(npm:*)')
    expect(question.question.endsWith('?')).toBe(true)
    expect(question.header.length).toBeLessThanOrEqual(12)
  })

  test('answers map to decisions; anything else rejects with the text as a note', () => {
    expect(interpretAnswer(LABELS.continue, false)).toEqual({ decision: 'continue' })
    expect(interpretAnswer(LABELS.step, false)).toEqual({ decision: 'step' })
    expect(interpretAnswer(LABELS.reject, false)).toEqual({ decision: 'reject' })
    expect(interpretAnswer(LABELS.simulate, true)).toEqual({ decision: 'simulate' })
    expect(interpretAnswer(LABELS.simulate, false).decision).toBe('reject')
    expect(interpretAnswer('use pnpm instead', false)).toEqual({ decision: 'reject', note: 'use pnpm instead' })
  })

  test('refusals tell Claude the call did not run', () => {
    for (const kind of ['debugger', 'cancelled', 'headless', 'aborted', 'guard'] as const) {
      expect(refusalText(kind, 'Bash', 'breakpoint "x"')).toMatch(/did not run|was not run/)
    }
    expect(refusalText('debugger', 'Bash', 'r', 'use pnpm')).toContain('"use pnpm"')
  })
})

describe('classifying results', () => {
  test('success, tool error, permission denial, hook refusal, interruption', () => {
    expect(classifyResult({ result: { stdout: '' } })).toEqual({ status: 'completed', outcome: 'ok' })
    expect(classifyResult({ isError: true, result: 'x', text: 'Exit code 1' })).toEqual({ status: 'failed', outcome: 'tool-error' })
    expect(classifyResult({ isError: true, result: 'x', text: "The user doesn't want to proceed with this tool use." })).toEqual({ status: 'denied', outcome: 'permission-denied' })
    expect(classifyResult({ isError: true, result: 'x', text: 'nope' }, { decision: 'deny', source: 'observed' })).toEqual({ status: 'denied', outcome: 'permission-denied' })
    expect(classifyResult({ deny: 'my-guard: this command is not allowed here' })).toEqual({ status: 'denied', outcome: 'blocked-by-hook' })
    expect(classifyResult({ isError: true, result: 'x', text: '[Request interrupted by user for tool use]' })).toEqual({ status: 'failed', outcome: 'aborted' })
    expect(classifyResult({ result: { stdout: '', stderr: '', interrupted: true } })).toEqual({ status: 'failed', outcome: 'aborted' })
  })
})

describe('risk and simulation', () => {
  test('risk labels', () => {
    expect(classifyRisk('Bash', 'ls -la && git status')).toBe('read')
    expect(classifyRisk('Bash', 'ls > out.txt')).toBe('exec')
    expect(classifyRisk('Bash', 'rm -rf node_modules')).toBe('destructive')
    expect(classifyRisk('Bash', 'git push --force origin main')).toBe('destructive')
    expect(classifyRisk('Bash', 'npx prisma migrate deploy')).toBe('destructive')
    expect(classifyRisk('Bash', 'npm install lodash')).toBe('network')
    for (const command of ['curl -I example.invalid', 'wget -q x', 'ssh host', 'nc -z h 80', 'iwr x', 'Invoke-WebRequest x', 'git clone x', 'pnpm add y', 'pip3 install z', 'cargo add w', 'go get v', 'docker pull u']) {
      expect(classifyRisk('Bash', command)).toBe('network')
    }
    for (const command of ['ncdu', 'curly', 'npm run build', 'git commit -m x']) expect(classifyRisk('Bash', command)).toBe('exec')
    expect(classifyRisk('Write')).toBe('write')
    expect(classifyRisk('Read')).toBe('read')
    expect(classifyRisk('mcp__x__y')).toBe('unknown')
  })

  test('simulation is off unless enabled, and limited by tool and kind', () => {
    const stubRule = parseBreakpointSpec('tool Bash --simulate stub --text "3 files"', 'bp1', 'all')
    if (!stubRule.ok) throw new Error(stubRule.error)
    expect(checkSimulation(false, undefined, bash('ls')).ok).toBe(false)
    expect(checkSimulation(true, undefined, bash('rm -rf /'))).toMatchObject({ ok: true, kind: 'fail' })
    expect(checkSimulation(true, stubRule.breakpoint, bash('ls'))).toMatchObject({ ok: true, kind: 'stub', text: '3 files' })
    expect(checkSimulation(true, stubRule.breakpoint, bash('npx prisma migrate deploy')).ok).toBe(false)
    expect(checkSimulation(true, undefined, normalizeCall({ tool: 'Agent', tool_use_id: 'a' })).ok).toBe(false)
  })

  test('synthetic results are labeled and never claim a side effect', () => {
    const failed = synthesize('fail', bash('npm publish'), 'registry down')
    expect('deny' in failed && failed.deny).toContain(SIMULATED_FAILURE_TAG)
    expect('deny' in failed && failed.deny).toContain('NOT executed')
    const stub = synthesize('stub', bash('ls'), 'a\nb')
    expect('result' in stub && stub.result.stdout.startsWith(SIMULATED_OUTPUT_TAG)).toBe(true)
    expect('result' in stub && stub.result).toEqual({ stdout: `${SIMULATED_OUTPUT_TAG}\na\nb`, stderr: '', interrupted: false })
  })
})
