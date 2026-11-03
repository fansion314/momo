import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { windowsUpdateInstallCommand } from './windows-update-install'

const execFilePromise = promisify(execFile)

describe.skipIf(process.platform !== 'win32' || process.env.MOMO_NATIVE_BOOTSTRAP_TEST !== '1')(
  'native Windows protected update bootstrap (administrator runner; no desktop UAC coverage)',
  () => {
    it('protects the installer, waits for graceful exit and restarts from the original caller context', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'Momo 更新 验收 '))
      const executable = path.join(directory, "中文 O'Brien $() setup.exe")
      const report = path.join(directory, 'result.txt')
      const restartReport = path.join(directory, 'restart.txt')
      const callerReport = path.join(directory, 'caller.txt')
      const installDirectory = path.join(directory, '中文 空格 Clash Momo')
      const application = path.join(installDirectory, 'Clash Momo.exe')
      const program = path.win32.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      )
      const reportPath = Buffer.from(report).toString('base64')
      const restartPath = Buffer.from(restartReport).toString('base64')
      const callerPath = Buffer.from(callerReport).toString('base64')
      const source = `using System; using System.IO; using System.Diagnostics; using System.Runtime.InteropServices; using System.Security.AccessControl; using System.Security.Principal;
public class MomoUpdateFixture {
  [DllImport("advapi32.dll", SetLastError=true)]
  private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)]
  private static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int infoSize, out int required);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  public static int Main(string[] args) {
    string exe = System.Reflection.Assembly.GetExecutingAssembly().Location;
    string security = Directory.GetAccessControl(Path.GetDirectoryName(exe)).GetSecurityDescriptorSddlForm(AccessControlSections.All);
    bool restarting = args.Length > 0 && args[0] == "--updated";
    bool caller = args.Length > 0 && args[0] == "--caller";
    string target = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(restarting ? "${restartPath}" : caller ? "${callerPath}" : "${reportPath}"));
    IntPtr token;
    if (!OpenProcessToken(Process.GetCurrentProcess().Handle, 8, out token)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    int elevationType, elevated, required;
    try {
      if (!GetTokenInformation(token, 18, out elevationType, 4, out required) || !GetTokenInformation(token, 20, out elevated, 4, out required)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { CloseHandle(token); }
    File.WriteAllLines(target, new string[] { exe, Environment.CommandLine, security, WindowsIdentity.GetCurrent().User.Value, elevationType.ToString(), elevated.ToString(), Process.GetCurrentProcess().SessionId.ToString() });
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
        await mkdir(installDirectory, { recursive: true })
        await cp(executable, application)
        await execFilePromise(executable, ['--caller'], { timeout: 10000, windowsHide: true })
        const bytes = await readFile(executable)
        parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
          stdio: 'ignore',
          windowsHide: true
        })
        if (!parent.pid) throw new Error('Missing fixture parent PID')
        const corruptCommand = windowsUpdateInstallCommand(
          executable,
          { name: path.basename(executable), size: bytes.length, sha256: '0'.repeat(64) },
          parent.pid,
          installDirectory
        )
        await expect(
          execFilePromise(corruptCommand.program, corruptCommand.args, {
            timeout: 60000,
            windowsHide: true
          })
        ).rejects.toThrow()
        await expect(stat(report)).rejects.toThrow()
        await expect(stat(restartReport)).rejects.toThrow()
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
        await expect(stat(restartReport)).rejects.toThrow()
        parent.kill()
        const deadline = Date.now() + 30000
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
            expect(commandLine).not.toContain('--force-run')
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
        let restarted: string[] | undefined
        while (Date.now() < deadline) {
          try {
            restarted = (await readFile(restartReport, 'utf8')).trim().split(/\r?\n/)
            break
          } catch (error) {
            if (Date.now() + 100 >= deadline) throw error
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }
        if (!restarted)
          throw new Error('The original caller did not restart the installed application')
        const caller = (await readFile(callerReport, 'utf8')).trim().split(/\r?\n/)
        expect(restarted[0]).toBe(application)
        expect(restarted[1]).toContain('--updated')
        expect(restarted.slice(3)).toEqual(caller.slice(3))
        await mkdir('dist/validation', { recursive: true })
        await writeFile(
          'dist/validation/windows-update-bootstrap.json',
          JSON.stringify(
            {
              restartedFrom: restarted[0],
              caller: {
                sid: caller[3],
                tokenElevationType: caller[4],
                elevated: caller[5],
                sessionId: caller[6]
              },
              restarted: {
                sid: restarted[3],
                tokenElevationType: restarted[4],
                elevated: restarted[5],
                sessionId: restarted[6]
              },
              scope:
                'Administrator CI runner; records caller-token preservation without claiming nonadministrator desktop or interactive UAC coverage.'
            },
            null,
            2
          ) + '\n'
        )
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
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
        if (protectedDirectory) await rm(protectedDirectory, { recursive: true, force: true })
      }
    }, 150000)
  }
)
