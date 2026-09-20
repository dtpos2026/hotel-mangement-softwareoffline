/**
 * Machine fingerprint for licence binding.
 *
 * Aims for a value that survives a reboot, a Windows update and a network
 * change, but differs between physical machines. On Windows the registry
 * MachineGuid is exactly that, so it is preferred; everything else is a
 * fallback built from properties that do not move on their own.
 *
 * MAC addresses are deliberately not used: docking, VPNs and switching between
 * Wi-Fi and Ethernet all change them, which would lock customers out of their
 * own licence.
 */

const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

let cached = null;

function windowsMachineGuid() {
  try {
    const out = execFileSync('reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', timeout: 4000, windowsHide: true });
    const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/.exec(out);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

function macMachineId() {
  try {
    const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'],
      { encoding: 'utf8', timeout: 4000 });
    const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

function linuxMachineId() {
  try {
    const fs = require('node:fs');
    for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      if (fs.existsSync(p)) {
        const v = fs.readFileSync(p, 'utf8').trim();
        if (v) return v.toLowerCase();
      }
    }
  } catch { /* fall through */ }
  return null;
}

/** Stable hardware traits, used when no OS machine id can be read. */
function fallbackTraits() {
  const cpus = os.cpus();
  return [
    os.platform(),
    os.arch(),
    cpus.length ? cpus[0].model.replace(/\s+/g, ' ').trim() : 'cpu',
    String(cpus.length),
    // Rounded to the nearest GB: a RAM reading wobbles by a few bytes.
    String(Math.round(os.totalmem() / (1024 * 1024 * 1024))),
    os.hostname()
  ].join('|');
}

/** The raw fingerprint string. Hashing happens where the licence is checked. */
function machineFingerprint() {
  if (cached) return cached;
  const id =
    (process.platform === 'win32' && windowsMachineGuid()) ||
    (process.platform === 'darwin' && macMachineId()) ||
    (process.platform === 'linux' && linuxMachineId()) ||
    null;

  cached = id ? `id:${id}` : `traits:${fallbackTraits()}`;
  return cached;
}

/**
 * The identifier stored against a licence in Firestore. Full sha256 of the
 * fingerprint, so it reveals nothing about the machine itself.
 */
function machineId() {
  return createHash('sha256').update(machineFingerprint(), 'utf8').digest('hex');
}

/** Short, readable code the customer reads out when asking for a bound licence. */
function machineCode() {
  const hex = createHash('sha256').update(machineFingerprint(), 'utf8').digest('hex').slice(0, 12).toUpperCase();
  return hex.replace(/(.{4})(?=.)/g, '$1-');
}

module.exports = { machineFingerprint, machineId, machineCode };
