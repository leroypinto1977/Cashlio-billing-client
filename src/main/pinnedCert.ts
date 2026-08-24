import { X509Certificate } from 'crypto'
import fs from 'fs'
import { join } from 'path'

/**
 * The one certificate this till will talk to.
 *
 * The branch server issues its own certificate — there is no certificate
 * authority in a shop — so Chromium has no reason to trust it and every
 * connection would be refused. Switching certificate checking off would make
 * the encryption pointless: anything on the shop's Wi-Fi could then answer in
 * the server's place and collect sessions and bills.
 *
 * Instead the till is told the fingerprint once, at pairing, at the moment a
 * manager is standing there authorising it. From then on it accepts exactly
 * that certificate and refuses everything else — a narrower promise than a
 * browser makes about a bank, not a looser one.
 *
 * Kept in the main process rather than the renderer: the check runs in the
 * main process, and a value the page could rewrite would not be a pin.
 */

const FILE = 'branch-cert.pin'

let cached: string | null = null
let loaded = false

function pinPath(userDataDir: string): string {
  return join(userDataDir, FILE)
}

export function getPinnedFingerprint(userDataDir: string): string | null {
  if (loaded) return cached
  try {
    const v = fs.readFileSync(pinPath(userDataDir), 'utf8').trim()
    cached = normalizeFingerprint(v).length === 64 ? v : null
  } catch {
    cached = null
  }
  loaded = true
  return cached
}

export function setPinnedFingerprint(userDataDir: string, fingerprint: string): boolean {
  if (normalizeFingerprint(fingerprint).length !== 64) return false
  fs.writeFileSync(pinPath(userDataDir), fingerprint, { mode: 0o600 })
  cached = fingerprint
  loaded = true
  return true
}

/** Used when a till is re-paired, possibly to a different branch server. */
export function clearPinnedFingerprint(userDataDir: string): void {
  try {
    fs.unlinkSync(pinPath(userDataDir))
  } catch {
    // Nothing pinned — that is the state we wanted anyway.
  }
  cached = null
  loaded = true
}

export function normalizeFingerprint(fp: string): string {
  return (fp || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
}

export function fingerprintsMatch(a: string, b: string): boolean {
  const x = normalizeFingerprint(a)
  const y = normalizeFingerprint(b)
  return x.length === 64 && x === y
}

/**
 * The fingerprint of a PEM certificate. Electron reports what it was offered
 * as `sha256/<base64>`, which doesn't compare against colon-hex; deriving it
 * from the certificate sidesteps the formatting question.
 */
export function fingerprintOfPem(pem: string): string | null {
  try {
    return new X509Certificate(pem).fingerprint256
  } catch {
    return null
  }
}
