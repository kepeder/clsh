import { spawn, type ChildProcess } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import ngrok from '@ngrok/ngrok';
// @ts-expect-error -- qrcode-terminal has no type declarations
import qrcode from 'qrcode-terminal';

export type TunnelMethod = 'ngrok' | 'ssh' | 'local';

export interface TunnelResult {
  url: string;
  method: TunnelMethod;
}

let activeNgrokListener: ngrok.Listener | null = null;
let activeSSHProcess: ChildProcess | null = null;

/**
 * Returns the first non-internal IPv4 address for this machine.
 * Used so phones on the same Wi-Fi can connect without any tunnel.
 */
function getLocalIP(): string | null {
  const nets = networkInterfaces();
  for (const interfaces of Object.values(nets)) {
    if (!interfaces) continue;
    for (const iface of interfaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

/**
 * Creates a public tunnel via localhost.run using SSH.
 * SSH is pre-installed on macOS — no account, no binary download required.
 * Resolves with the public HTTPS URL once the tunnel is established.
 */
function createSSHTunnel(localPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const ssh = spawn('ssh', [
      '-R', `80:localhost:${localPort}`,
      'nokey@localhost.run',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
    ]);

    activeSSHProcess = ssh;

    const urlPattern = /https:\/\/[a-zA-Z0-9-]+\.(?:localhost\.run|lhr\.life)/;
    let resolved = false;

    const tryResolve = (data: Buffer) => {
      if (resolved) return;
      const match = urlPattern.exec(data.toString());
      if (match) {
        resolved = true;
        resolve(match[0]);
      }
    };

    ssh.stdout.on('data', tryResolve);
    ssh.stderr.on('data', tryResolve);

    ssh.on('error', (err) => {
      if (!resolved) reject(err);
    });

    ssh.on('close', (code) => {
      if (!resolved) {
        reject(new Error(`SSH exited with code ${String(code)}`));
      }
    });

    setTimeout(() => {
      if (!resolved) {
        ssh.kill();
        reject(new Error('localhost.run tunnel timed out after 12s'));
      }
    }, 12_000);
  });
}

/**
 * Creates a public tunnel to expose the local server.
 *
 * Priority order:
 *  1. ngrok    — if NGROK_AUTHTOKEN is set (most reliable, needs free account)
 *  2. SSH      — localhost.run via SSH, zero install, no account needed
 *  3. local    — local network IP, works when phone is on the same Wi-Fi
 */
export async function createTunnel(
  port: number,
  ngrokAuthtoken?: string,
  ngrokStaticDomain?: string,
  forcedMethod?: 'ngrok' | 'ssh' | 'local',
): Promise<TunnelResult> {
  // 1. ngrok — best reliability, optional free-account token
  if (forcedMethod !== 'ssh' && forcedMethod !== 'local' && ngrokAuthtoken) {
    try {
      const ngrokOpts: Parameters<typeof ngrok.forward>[0] = {
        addr: port,
        authtoken: ngrokAuthtoken,
      };
      if (ngrokStaticDomain) ngrokOpts.domain = ngrokStaticDomain;
      const listener = await ngrok.forward(ngrokOpts);
      activeNgrokListener = listener;
      const url = listener.url();
      if (url) return { url, method: 'ngrok' };
    } catch {
      // ngrok failed — try SSH
    }
  }

  // 2. localhost.run via SSH (pre-installed on macOS, no account needed)
  if (forcedMethod === 'local') {
    const localIp = getLocalIP();
    const url = localIp ? `http://${localIp}:${port}` : `http://localhost:${port}`;
    return { url, method: 'local' };
  }
  try {
    const url = await createSSHTunnel(port);
    return { url, method: 'ssh' };
  } catch {
    // SSH failed — fall back to local
  }

  // 3. Local network — works on same Wi-Fi, no internet required
  const localIp = getLocalIP();
  const url = localIp ? `http://${localIp}:${port}` : `http://localhost:${port}`;
  return { url, method: 'local' };
}

/**
 * Prints a clean startup banner with QR code and access info.
 */
export function printAccessInfo(
  publicUrl: string,
  bootstrapToken: string,
  method: TunnelMethod,
): void {
  const authUrl = `${publicUrl}/?token=${bootstrapToken}`;

  // ANSI orange (256-color: 208)
  const o = '\x1b[38;5;208m';
  const dim = '\x1b[2m';
  const r = '\x1b[0m';

  console.log('');
  console.log(`${o}    ██████╗██╗     ███████╗██╗  ██╗${r}`);
  console.log(`${o}   ██╔════╝██║     ██╔════╝██║  ██║${r}`);
  console.log(`${o}   ██║     ██║     ███████╗███████║${r}`);
  console.log(`${o}   ██║     ██║     ╚════██║██╔══██║${r}`);
  console.log(`${o}   ╚██████╗███████╗███████║██║  ██║${r}`);
  console.log(`${o}    ╚═════╝╚══════╝╚══════╝╚═╝  ╚═╝${r}`);
  console.log(`${dim}              clsh.dev${r}`);
  console.log('');

  qrcode.generate(authUrl, { small: true }, (code: string) => {
    // Print QR in default terminal colors (high contrast in both light & dark terminals)
    console.log(code);
    console.log(`${o}  Scan to connect ${dim}(token embedded in QR)${r}`);
    console.log('');
    console.log(`${o}  URL:   ${r}${publicUrl}`);
    console.log(`${o}  Token: ${r}${bootstrapToken}`);
    console.log(`${o}  Mode:  ${r}${method === 'ngrok' ? 'remote (ngrok)' : method === 'ssh' ? 'remote (ssh)' : 'local Wi-Fi only'}`);
    if (method === 'local') {
      console.log('');
      console.log(`${o}  ⚠  Local mode — phone must be on same Wi-Fi.${r}`);
      console.log(`${dim}     Set NGROK_AUTHTOKEN in .env for remote access.${r}`);
    }
    console.log('');
  });
}

/**
 * Closes any active tunnels (ngrok listener and/or SSH process).
 */
export async function closeTunnel(): Promise<void> {
  if (activeNgrokListener) {
    try { await ngrok.disconnect(); } catch { /* ignore */ }
    activeNgrokListener = null;
  }
  if (activeSSHProcess) {
    activeSSHProcess.kill();
    activeSSHProcess = null;
  }
}

/**
 * Registers SIGINT/SIGTERM handlers for graceful shutdown.
 */
export function registerShutdownHandlers(cleanup: () => void | Promise<void>): void {
  const shutdown = async (signal: string) => {
    console.log(`\n  Received ${signal}, shutting down...`);
    try {
      await cleanup();
      await closeTunnel();
    } catch (err) {
      console.error('  Error during shutdown:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
