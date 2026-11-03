import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { windowsUpdateInstallCommand } from './windows-update-install'

const execFilePromise = promisify(execFile)

describe.skipIf(process.platform !== 'win32' || process.env.MOMO_NATIVE_BOOTSTRAP_TEST !== '1')(
  'native Windows protected update bootstrap (administrator runner; no desktop UAC coverage)',
  () => {
    it('protects the copied installer, preserves the explicit installation path, waits for the parent and cleans staging', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'Momo 更新 验收 '))
      const executable = path.join(directory, "中文 O'Brien $() setup.exe")
      const report = path.join(directory, 'result.txt')
      const installDirectory = 'D:\\中文 空格\\Clash Momo'
      const program = path.win32.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      )
      const reportPath = Buffer.from(report).toString('base64')
      const source = `using System; using System.IO; using System.Security.AccessControl;
public class MomoUpdateFixture {
  public static int Main(string[] args) {
    string exe = System.Reflection.Assembly.GetExecutingAssembly().Location;
    string security = Directory.GetAccessControl(Path.GetDirectoryName(exe)).GetSecurityDescriptorSddlForm(AccessControlSections.All);
    File.WriteAllLines(System.Text.Encoding.UTF8.GetString(Convert.FromBase64String("${reportPath}")), new string[] { exe, Environment.CommandLine, security });
    return 0;
  }
}`
      const payload = Buffer.from(JSON.stringify({ executable, source })).toString('base64')
      const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; Add-Type -TypeDefinition $p.source -OutputAssembly $p.executable -OutputType ConsoleApplication`
      let parent: ReturnType<typeof spawn> | undefined
      let protectedDirectory: string | undefined
      try {
        await execFilePromise(
          program,
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64')
          ],
          { timeout: 30000, windowsHide: true }
        )
        const bytes = await readFile(executable)
        parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
          stdio: 'ignore',
          windowsHide: true
        })
        if (!parent.pid) throw new Error('Missing fixture parent PID')
        const command = windowsUpdateInstallCommand(
          executable,
          {
            name: path.basename(executable),
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex')
          },
          parent.pid,
          installDirectory
        )
        await execFilePromise(command.program, command.args, {
          timeout: 60000,
          windowsHide: true,
          env: { ...process.env, MOMO_UPDATE_FIXTURE_REPORT: report }
        })
        // The protected copy is ready, but the installer must not execute while
        // the old application is still alive and flushing its traffic database.
        await expect(stat(report)).rejects.toThrow()
        parent.kill()
        const deadline = Date.now() + 15000
        while (Date.now() < deadline) {
          try {
            const [installedFrom, commandLine, security] = (await readFile(report, 'utf8'))
              .trim()
              .split(/\r?\n/)
            protectedDirectory = path.dirname(installedFrom)
            expect(installedFrom).not.toBe(executable)
            expect(protectedDirectory).toContain('ClashMomoUpdate-')
            expect(commandLine).toContain(`/D=${installDirectory}`)
            expect(commandLine).toContain('--updated')
            expect(security).toMatch(/O:BA/)
            expect(security).toContain(';;;BA)')
            expect(security).toContain(';;;SY)')
            expect(security).not.toContain(';;;WD)')
            expect(security).not.toContain(';;;BU)')
            break
          } catch (error) {
            if (Date.now() + 100 >= deadline) throw error
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }
        if (!protectedDirectory) throw new Error('Protected installer did not produce a report')
        while (Date.now() < deadline) {
          try {
            await stat(protectedDirectory)
          } catch {
            protectedDirectory = undefined
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        expect(protectedDirectory).toBeUndefined()
      } finally {
        parent?.kill()
        await rm(directory, { recursive: true, force: true })
        if (protectedDirectory) await rm(protectedDirectory, { recursive: true, force: true })
      }
    }, 90000)
  }
)
