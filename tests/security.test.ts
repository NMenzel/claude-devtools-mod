import { describe, expect, test } from 'claude-code/testing'

import { normalizeCall, sanitizeInput, summarizeInput, summarizeResult } from '../src/core/events.ts'
import { isSensitiveKey, REDACTED, redactString, redactValue } from '../src/security/redaction.ts'

const OPTIONS = { maxChars: 400, redaction: true, captureRaw: false }

describe('redaction', () => {
  test('credential shapes in free text', () => {
    // Fake credentials, joined at run time so the source holds no token-shaped string for secret scanners to flag.
    const join = (...parts: string[]): string => parts.join('')
    const text = [
      'Authorization: Bearer abcdefghijklmnop123',
      join('key sk-', 'ant-api03-ABCDEFGHIJKLMNOPQRSTUV'),
      join('gh ghp', '_0123456789abcdefghij0123456789'),
      join('aws AKIA', 'ABCDEFGHIJKLMNOP'),
      'jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4fw',
      'url https://admin:hunter2@db.example.com/x',
      join('-----BEGIN RSA PRIVATE', ' KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'),
    ].join('\n')
    const out = redactString(text)
    for (const secret of ['abcdefghijklmnop123', 'sk-ant-api03', 'ghp_0123', 'AKIAABCD', 'eyJhbGci', 'hunter2', 'MIIEow']) {
      expect(out).not.toContain(secret)
    }
    expect(out).toContain('https://admin:[REDACTED]@db.example.com/x')
  })

  test('more key shapes: Stripe, Slack refresh tokens, Twilio API keys', () => {
    const join = (...parts: string[]): string => parts.join('')
    for (const key of [join('sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc'), join('rk_', 'test_', '51Habcdefghijklmnop'), join('pk_', 'live_', 'ABCDEFGHIJKLMNOP1234')]) {
      expect(redactString(`key ${key} end`)).toBe(`key ${REDACTED} end`)
    }
    expect(redactString('sk_live_short')).toBe('sk_live_short')
    expect(redactString(join('slack xoxe', '.xoxp-1-AbCdEfGhIjKlMnOp'))).toBe(`slack ${REDACTED}`)
    expect(redactString(join('twilio SK', '0123456789abcdef0123456789abcdef'))).toBe(`twilio ${REDACTED}`)
  })

  test('environment assignments and secret flags in commands', () => {
    expect(redactString('API_TOKEN=abc123 npm publish')).toBe(`API_TOKEN=${REDACTED} npm publish`)
    expect(redactString('export DATABASE_URL="postgres://u:p@h/db" && run')).toBe(`export DATABASE_URL=${REDACTED} && run`)
    expect(redactString('NODE_ENV=production node app.js')).toBe(`NODE_ENV=${REDACTED} node app.js`)
    expect(redactString('$env:APP_MODE = "x1"')).toBe(`$env:APP_MODE = ${REDACTED}`)
    expect(redactString('mysql --password=s3cret -u root')).toBe(`mysql --password=${REDACTED} -u root`)
    expect(redactString('curl -H "X-Api-Key: abc123def"')).toContain(REDACTED)
    expect(redactString('git status')).toBe('git status')
  })

  test('sensitive keys, by word, in nested data', () => {
    expect(isSensitiveKey('apiKey')).toBe(true)
    expect(isSensitiveKey('client_secret')).toBe(true)
    expect(isSensitiveKey('Authorization')).toBe(true)
    expect(isSensitiveKey('author')).toBe(false)
    expect(isSensitiveKey('max_tokens')).toBe(false)
    expect(redactValue({ headers: { Authorization: 'x', accept: 'json' }, list: [{ password: 'p' }] })).toEqual({
      headers: { Authorization: REDACTED, accept: 'json' },
      list: [{ password: REDACTED }],
    })
  })
})

describe('what the timeline keeps', () => {
  test('file contents are omitted from inputs unless raw capture is on', () => {
    const call = normalizeCall({ tool: 'Write', tool_use_id: 'w', file_path: '/r/.env', content: 'SECRET=1\nTOKEN=2' })
    expect(sanitizeInput(call, OPTIONS)).toEqual({ file_path: '/r/.env', content: '<16 chars omitted>' })
    expect(summarizeInput(call, OPTIONS)).toBe('/r/.env  (16 chars)')
    expect(sanitizeInput(call, { ...OPTIONS, captureRaw: true }).content).toBe(`SECRET=${REDACTED}\nTOKEN=${REDACTED}`)
  })

  test('commands are redacted in summaries and inputs', () => {
    const call = normalizeCall({ tool: 'Bash', tool_use_id: 'b', command: 'STRIPE_KEY=sk_live_123 node pay.js', description: 'pay' })
    expect(summarizeInput(call, OPTIONS)).toBe(`STRIPE_KEY=${REDACTED} node pay.js`)
    expect(sanitizeInput(call, OPTIONS).command).toBe(`STRIPE_KEY=${REDACTED} node pay.js`)
  })

  test('results are summarized without their contents', () => {
    const summary = summarizeResult('Bash', { result: { stdout: 'AWS_SECRET=abc\nline2\n', stderr: '', interrupted: false } }, OPTIONS)
    expect(summary).toBe('stdout 2 lines, stderr 0 lines')
    expect(summarizeResult('Read', { result: { type: 'text' }, text: 'secret file\ncontents' }, OPTIONS)).toBe('2 lines, 20 chars')
    expect(summarizeResult('Bash', { isError: true, result: 'x', text: 'failed: TOKEN=abc' }, OPTIONS)).toBe(`error: failed: TOKEN=${REDACTED}`)
  })

  test('a huge command is cut before redaction, dropping the word the cut splits', () => {
    const join = (...parts: string[]): string => parts.join('')
    const key = join('sk-', 'ant-api03-ABCDEFGHIJKLMNOPQRSTUV')
    const call = normalizeCall({ tool: 'Bash', tool_use_id: 'b', command: `echo ${key} ${'x'.repeat(65_480)} ${key}` })
    const shown = summarizeInput(call, { ...OPTIONS, maxChars: 200_000 })
    expect(shown.startsWith(`echo ${REDACTED} x`)).toBe(true)
    expect(shown).not.toContain('sk-')
    expect(shown.length).toBeLessThan(65_536)
  })

  test('long runs of spaces and blank lines summarize in linear time', () => {
    const started = Date.now()
    for (const command of [`echo a${' '.repeat(70_000)}b`, `cat <<EOF${'\n'.repeat(30_000)}x${' '.repeat(40_000)}\nEOF`]) {
      summarizeInput(normalizeCall({ tool: 'Bash', tool_use_id: 'b', command }), OPTIONS)
    }
    expect(Date.now() - started).toBeLessThan(500)
    expect(summarizeInput(normalizeCall({ tool: 'Bash', tool_use_id: 'b', command: 'a\n\n  \nb  ' }), OPTIONS)).toBe('a ⏎ b')
  })

  test('a tool with no summary of its own is redacted by key, as its stored input is', () => {
    const call = normalizeCall({ tool: 'mcp__db__connect', tool_use_id: 'm', host: 'db', password: 'hunter2', api_key: 'plainvalue123' })
    const shown = summarizeInput(call, OPTIONS)
    expect(shown).toContain('"host":"db"')
    expect(shown).not.toContain('hunter2')
    expect(shown).not.toContain('plainvalue123')
  })

  test('long values are truncated to the summary length', () => {
    const call = normalizeCall({ tool: 'Bash', tool_use_id: 'b', command: 'echo ' + 'x'.repeat(1000) })
    expect(summarizeInput(call, { ...OPTIONS, maxChars: 50 }).length).toBe(50)
  })
})
