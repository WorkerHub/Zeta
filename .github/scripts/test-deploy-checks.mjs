// Regression tests for the deploy workflow's "Write secrets file" step.
//
// The step's real shell body is extracted from .github/workflows/deploy.yml and executed in a
// throwaway RUNNER_TEMP with a controlled environment — nothing is re-implemented here, so the
// assertions follow the workflow instead of drifting from it. Secrets are only ever checked by
// key name: the test never reads, prints or compares a real value.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const WORKFLOW_PATH = fileURLToPath(new URL('../workflows/deploy.yml', import.meta.url))
const STEP_NAME = 'Write secrets file'

const workflow = await readFile(WORKFLOW_PATH, 'utf8')

// Body of the named step: every line after its `- name:` until the next step starts.
function stepBody(yaml, name) {
  const lines = yaml.split('\n')
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`)
  assert.notEqual(start, -1, `deploy.yml has no "${name}" step`)
  const startIndent = lines[start].search(/\S/)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => {
    const indent = line.search(/\S/)
    return indent !== -1 && indent <= startIndent && line.trim().startsWith('- name:')
  })
  return end === -1 ? rest : rest.slice(0, end)
}

const body = stepBody(workflow, STEP_NAME)

// `NAME: ${{ secrets.NAME }}` entries of the step's env block.
const declaredSecrets = Object.fromEntries(
  body
    .map((line) => line.match(/^\s+([A-Za-z0-9_]+):\s*\$\{\{ secrets\.([A-Za-z0-9_]+) \}\}\s*$/))
    .filter(Boolean)
    .map(([, name, secret]) => [name, secret])
)

// The shell the step runs, dedented out of the `run: |` block.
function runBody(stepLines) {
  const start = stepLines.findIndex((line) => /^\s+run:\s*\|\s*$/.test(line))
  assert.notEqual(start, -1, `"${STEP_NAME}" step has no block run script`)
  const indent = stepLines[start].search(/\S/)
  const script = []
  for (const line of stepLines.slice(start + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= indent) break
    script.push(line)
  }
  const common = Math.min(...script.filter((line) => line.trim() !== '').map((line) => line.search(/\S/)))
  return `${script.map((line) => line.slice(common).trimEnd()).join('\n')}\n`
}

// Required-key names the step fail-closes on: `for name in A B C; do`.
const requiredKeys = (() => {
  const line = runBody(body)
    .split('\n')
    .find((candidate) => candidate.startsWith('for name in '))
  assert.ok(line, `"${STEP_NAME}" step does not declare its required secrets in a for loop`)
  return line
    .replace(/^for name in /, '')
    .replace(/; do$/, '')
    .split(/\s+/)
})()

const script = runBody(body)

const SECRET_VALUE = 'test-value-not-a-real-secret'

const sandboxes = []
after(async () => {
  await Promise.all(sandboxes.map((dir) => rm(dir, { recursive: true, force: true })))
})

// Runs the step's script with exactly the given environment plus PATH, returning its result.
async function runStep(env) {
  const dir = await mkdtemp(join(tmpdir(), 'zeta-deploy-checks-'))
  sandboxes.push(dir)
  const scriptPath = join(dir, 'write-secrets.sh')
  await writeFile(scriptPath, script)
  try {
    const { stdout, stderr } = await execFileAsync('bash', [scriptPath], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', RUNNER_TEMP: dir, ...env },
    })
    return { code: 0, stdout, stderr, secretsPath: join(dir, 'secrets.json') }
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      secretsPath: join(dir, 'secrets.json'),
    }
  }
}

const allSecrets = () => Object.fromEntries(requiredKeys.map((name) => [name, SECRET_VALUE]))

describe(`${STEP_NAME} step`, () => {
  it('takes ENCRYPTION_KEY from the repo secret ENCRYPTION_KEY', () => {
    assert.equal(
      declaredSecrets.ENCRYPTION_KEY,
      'ENCRYPTION_KEY',
      'the step must inject ENCRYPTION_KEY from the repository secret of the same name'
    )
  })

  it('fail-closes on every secret it injects', () => {
    assert.deepEqual(
      [...requiredKeys].sort(),
      Object.keys(declaredSecrets).sort(),
      'every injected secret must be validated, and every validated secret injected'
    )
  })

  it('writes ENCRYPTION_KEY into the secrets file', async () => {
    const result = await runStep(allSecrets())
    assert.equal(result.code, 0, `step failed: ${result.stdout}${result.stderr}`)
    const written = JSON.parse(await readFile(result.secretsPath, 'utf8'))
    assert.deepEqual(Object.keys(written).sort(), [...requiredKeys].sort())
    assert.ok(
      Object.hasOwn(written, 'ENCRYPTION_KEY'),
      'secrets file must carry the ENCRYPTION_KEY key so it is uploaded with the version'
    )
    assert.equal(written.ENCRYPTION_KEY, SECRET_VALUE)
    assert.equal((await stat(result.secretsPath)).mode & 0o777, 0o600)
  })

  it('fails closed and names ENCRYPTION_KEY when it is missing', async () => {
    const { ENCRYPTION_KEY: _omitted, ...withoutKey } = allSecrets()
    const result = await runStep(withoutKey)
    assert.notEqual(result.code, 0, 'step must fail when ENCRYPTION_KEY is unset')
    assert.match(result.stdout + result.stderr, /::error::missing secret: ENCRYPTION_KEY\b/)
    await assert.rejects(stat(result.secretsPath), 'no secrets file may be written when failing')
  })

  it('fails closed when ENCRYPTION_KEY is empty', async () => {
    const result = await runStep({ ...allSecrets(), ENCRYPTION_KEY: '' })
    assert.notEqual(result.code, 0, 'step must fail when ENCRYPTION_KEY is blank')
    assert.match(result.stdout + result.stderr, /::error::missing secret: ENCRYPTION_KEY\b/)
    await assert.rejects(stat(result.secretsPath), 'no secrets file may be written when failing')
  })
})
