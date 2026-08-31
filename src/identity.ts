/** Agent identity — its own AIN keypair in ~/.ngram-agent/identity.json (NGRAM_AGENT_HOME overrides). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, identityFromPrivateKey, signMessage, type Identity } from '@ngram/core';

export function agentHome(explicit?: string): string {
  return explicit ?? process.env.NGRAM_AGENT_HOME ?? join(homedir(), '.ngram-agent');
}

export function loadIdentity(home = agentHome(), privateKey?: string): Identity {
  if (privateKey) return identityFromPrivateKey(privateKey);
  const file = join(home, 'identity.json');
  if (existsSync(file)) {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { privateKey: string };
    return identityFromPrivateKey(j.privateKey);
  }
  const id = createIdentity();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(id, null, 2) + '\n', { mode: 0o600 });
  return id;
}

/** Mirrors @ngram/node authHeader(): `<address>:<ts>:<sig over "purpose:ts">` */
export function authHeader(identity: Identity, purpose: string): string {
  const ts = Date.now();
  return `${identity.address}:${ts}:${signMessage(`${purpose}:${ts}`, identity.privateKey)}`;
}
