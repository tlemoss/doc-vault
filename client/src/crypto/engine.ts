const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const DEFAULT_KDF_ITERATIONS = 600_000;
const RECOVERY_KDF_ITERATIONS = 100_000;

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'Web Crypto API indisponível. Acesse via https:// ou http://localhost para habilitar criptografia ponta-a-ponta.'
    );
  }
  return subtle;
}

export function randomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export interface DerivedMasterKeys {
  authKeyB64: string;
  masterWrappingKey: CryptoKey;
}

/**
 * Derives two cryptographically independent keys from the user's master password:
 * - authKeyB64: sent to the server for authentication (never decrypts vault data)
 * - masterWrappingKey: stays strictly in client memory to decrypt the user's private key
 */
export async function deriveMasterKeys(
  password: string,
  saltB64: string,
  iterations: number = DEFAULT_KDF_ITERATIONS
): Promise<DerivedMasterKeys> {
  const subtle = getSubtle();
  const salt = fromBase64(saltB64);

  const basePasswordKey = await subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const masterSecretBits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations,
      hash: 'SHA-256',
    },
    basePasswordKey,
    256
  );

  const hkdfMaterial = await subtle.importKey(
    'raw',
    masterSecretBits,
    'HKDF',
    false,
    ['deriveBits', 'deriveKey']
  );

  const authBits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: encoder.encode('documents-vault:auth:v1'),
    },
    hkdfMaterial,
    256
  );

  const masterWrappingKey = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: encoder.encode('documents-vault:wrap:v1'),
    },
    hkdfMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  return {
    authKeyB64: toBase64(new Uint8Array(authBits)),
    masterWrappingKey,
  };
}

export function generateRecoveryKey(): string {
  const raw = randomBytes(32);
  const hex = toHex(raw).toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 8) {
    groups.push(hex.slice(i, i + 8));
  }
  return groups.join('-');
}

export function normalizeRecoveryKey(input: string): string {
  return input.replace(/[\s-]+/g, '').toUpperCase();
}

export async function deriveRecoveryKeys(
  recoveryKeyInput: string,
  recoverySaltB64: string
): Promise<{ recoveryAuthKeyB64: string; recoveryWrappingKey: CryptoKey }> {
  const subtle = getSubtle();
  const normalized = normalizeRecoveryKey(recoveryKeyInput);
  if (normalized.length < 32) {
    throw new Error('Formato de chave de recuperação inválido.');
  }
  const salt = fromBase64(recoverySaltB64);

  const baseKey = await subtle.importKey(
    'raw',
    encoder.encode(normalized),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const secretBits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations: RECOVERY_KDF_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    256
  );

  const hkdfMaterial = await subtle.importKey('raw', secretBits, 'HKDF', false, [
    'deriveBits',
    'deriveKey',
  ]);

  const recoveryAuthBits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: encoder.encode('documents-vault:recovery-auth:v1'),
    },
    hkdfMaterial,
    256
  );

  const recoveryWrappingKey = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: encoder.encode('documents-vault:recovery-wrap:v1'),
    },
    hkdfMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  return {
    recoveryAuthKeyB64: toBase64(new Uint8Array(recoveryAuthBits)),
    recoveryWrappingKey,
  };
}

export interface GeneratedUserKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyB64: string;
  publicKeyFingerprint: string;
  privateKeyPkcs8: Uint8Array;
}

export async function generateUserKeyPair(): Promise<GeneratedUserKeyPair> {
  const subtle = getSubtle();
  const pair = await subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt']
  );

  const spki = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  const digest = new Uint8Array(await subtle.digest('SHA-256', toArrayBuffer(spki)));
  const hex = toHex(digest).toUpperCase();
  const fingerprint = hex.slice(0, 32).match(/.{1,4}/g)?.join(':') ?? hex;

  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicKeyB64: toBase64(spki),
    publicKeyFingerprint: fingerprint,
    privateKeyPkcs8: pkcs8,
  };
}

export async function encryptPrivateKey(
  pkcs8: Uint8Array,
  wrappingKey: CryptoKey
): Promise<{ ciphertext: string; iv: string }> {
  const subtle = getSubtle();
  const iv = randomBytes(12);
  const encrypted = await subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    wrappingKey,
    toArrayBuffer(pkcs8)
  );
  return {
    ciphertext: toBase64(new Uint8Array(encrypted)),
    iv: toBase64(iv),
  };
}

export async function decryptPrivateKey(
  encryptedB64: string,
  ivB64: string,
  wrappingKey: CryptoKey,
  extractable: boolean = false
): Promise<CryptoKey> {
  const subtle = getSubtle();
  const ciphertext = fromBase64(encryptedB64);
  const iv = fromBase64(ivB64);

  const decrypted = await subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    wrappingKey,
    toArrayBuffer(ciphertext)
  );

  return subtle.importKey(
    'pkcs8',
    decrypted,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    extractable,
    ['decrypt']
  );
}

export async function exportPrivateKeyBytes(privateKey: CryptoKey): Promise<Uint8Array> {
  const subtle = getSubtle();
  return new Uint8Array(await subtle.exportKey('pkcs8', privateKey));
}

export async function importPublicKey(publicKeyB64: string): Promise<CryptoKey> {
  const subtle = getSubtle();
  const spki = fromBase64(publicKeyB64);
  return subtle.importKey(
    'spki',
    toArrayBuffer(spki),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
}

export async function generateAesKey(): Promise<CryptoKey> {
  const subtle = getSubtle();
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

export async function wrapTabKeyForPublicKey(
  tabKey: CryptoKey,
  recipientPublicKeyB64: string
): Promise<string> {
  const subtle = getSubtle();
  const rawTabKey = await subtle.exportKey('raw', tabKey);
  const pubKey = await importPublicKey(recipientPublicKeyB64);
  const wrapped = await subtle.encrypt({ name: 'RSA-OAEP' }, pubKey, rawTabKey);
  return toBase64(new Uint8Array(wrapped));
}

export async function unwrapTabKeyWithPrivateKey(
  wrappedTabKeyB64: string,
  privateKey: CryptoKey
): Promise<CryptoKey> {
  const subtle = getSubtle();
  const wrapped = fromBase64(wrappedTabKeyB64);
  const rawKey = await subtle.decrypt(
    { name: 'RSA-OAEP' },
    privateKey,
    toArrayBuffer(wrapped)
  );
  return subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

export async function wrapFileKey(
  fileKey: CryptoKey,
  tabKey: CryptoKey
): Promise<{ wrappedFileKey: string; fileKeyIv: string }> {
  const subtle = getSubtle();
  const rawFileKey = await subtle.exportKey('raw', fileKey);
  const iv = randomBytes(12);
  const wrapped = await subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    tabKey,
    rawFileKey
  );
  return {
    wrappedFileKey: toBase64(new Uint8Array(wrapped)),
    fileKeyIv: toBase64(iv),
  };
}

export async function unwrapFileKey(
  wrappedFileKeyB64: string,
  fileKeyIvB64: string,
  tabKey: CryptoKey
): Promise<CryptoKey> {
  const subtle = getSubtle();
  const wrapped = fromBase64(wrappedFileKeyB64);
  const iv = fromBase64(fileKeyIvB64);
  const rawKey = await subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    tabKey,
    toArrayBuffer(wrapped)
  );
  return subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptText(
  plaintext: string,
  key: CryptoKey
): Promise<{ ciphertext: string; iv: string }> {
  const subtle = getSubtle();
  const iv = randomBytes(12);
  const encrypted = await subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    encoder.encode(plaintext)
  );
  return {
    ciphertext: toBase64(new Uint8Array(encrypted)),
    iv: toBase64(iv),
  };
}

export async function decryptText(
  ciphertextB64: string,
  ivB64: string,
  key: CryptoKey
): Promise<string> {
  const subtle = getSubtle();
  const ciphertext = fromBase64(ciphertextB64);
  const iv = fromBase64(ivB64);
  const decrypted = await subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ciphertext)
  );
  return decoder.decode(decrypted);
}

export async function encryptJson<T>(
  data: T,
  key: CryptoKey
): Promise<{ ciphertext: string; iv: string }> {
  return encryptText(JSON.stringify(data), key);
}

export async function decryptJson<T>(
  ciphertextB64: string,
  ivB64: string,
  key: CryptoKey
): Promise<T> {
  const json = await decryptText(ciphertextB64, ivB64, key);
  return JSON.parse(json) as T;
}

export async function encryptBinary(
  plaintext: ArrayBuffer,
  key: CryptoKey
): Promise<{ ciphertext: Uint8Array; iv: string }> {
  const subtle = getSubtle();
  const iv = randomBytes(12);
  const encrypted = await subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    plaintext
  );
  return {
    ciphertext: new Uint8Array(encrypted),
    iv: toBase64(iv),
  };
}

export async function decryptBinary(
  ciphertext: ArrayBuffer,
  ivB64: string,
  key: CryptoKey
): Promise<ArrayBuffer> {
  const subtle = getSubtle();
  const iv = fromBase64(ivB64);
  return subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    ciphertext
  );
}

export interface RegistrationPayload {
  username: string;
  kdfSalt: string;
  kdfIterations: number;
  authKey: string;
  publicKey: string;
  publicKeyFingerprint: string;
  encryptedPrivateKey: string;
  privateKeyIv: string;
  recoveryEncryptedPrivateKey: string;
  recoveryIv: string;
  recoverySalt: string;
  recoveryAuthKey: string;
}

export async function createRegistrationBundle(
  username: string,
  password: string,
  iterations: number = DEFAULT_KDF_ITERATIONS
): Promise<{
  payload: RegistrationPayload;
  recoveryKey: string;
  privateKey: CryptoKey;
}> {
  const kdfSalt = toBase64(randomBytes(16));
  const recoverySalt = toBase64(randomBytes(16));
  const recoveryKey = generateRecoveryKey();

  const [masterKeys, recoveryKeys, keyPair] = await Promise.all([
    deriveMasterKeys(password, kdfSalt, iterations),
    deriveRecoveryKeys(recoveryKey, recoverySalt),
    generateUserKeyPair(),
  ]);

  const [encPrivMaster, encPrivRecovery] = await Promise.all([
    encryptPrivateKey(keyPair.privateKeyPkcs8, masterKeys.masterWrappingKey),
    encryptPrivateKey(keyPair.privateKeyPkcs8, recoveryKeys.recoveryWrappingKey),
  ]);

  // Zero out exported private key bytes in memory
  keyPair.privateKeyPkcs8.fill(0);

  return {
    recoveryKey,
    privateKey: keyPair.privateKey,
    payload: {
      username: username.trim(),
      kdfSalt,
      kdfIterations: iterations,
      authKey: masterKeys.authKeyB64,
      publicKey: keyPair.publicKeyB64,
      publicKeyFingerprint: keyPair.publicKeyFingerprint,
      encryptedPrivateKey: encPrivMaster.ciphertext,
      privateKeyIv: encPrivMaster.iv,
      recoveryEncryptedPrivateKey: encPrivRecovery.ciphertext,
      recoveryIv: encPrivRecovery.iv,
      recoverySalt,
      recoveryAuthKey: recoveryKeys.recoveryAuthKeyB64,
    },
  };
}

export async function createRecoveryResetBundle(
  username: string,
  recoveryKey: string,
  recoverySalt: string,
  recoveryEncryptedPrivateKey: string,
  recoveryIv: string,
  newPassword: string,
  iterations: number = DEFAULT_KDF_ITERATIONS
): Promise<{
  payload: {
    username: string;
    recoveryAuthKey: string;
    kdfSalt: string;
    kdfIterations: number;
    authKey: string;
    encryptedPrivateKey: string;
    privateKeyIv: string;
  };
  privateKey: CryptoKey;
}> {
  const recoveryKeys = await deriveRecoveryKeys(recoveryKey, recoverySalt);
  const recoveredPrivateKey = await decryptPrivateKey(
    recoveryEncryptedPrivateKey,
    recoveryIv,
    recoveryKeys.recoveryWrappingKey,
    true
  );

  const pkcs8 = await exportPrivateKeyBytes(recoveredPrivateKey);
  const kdfSalt = toBase64(randomBytes(16));
  const nextMaster = await deriveMasterKeys(newPassword, kdfSalt, iterations);
  const reEncrypted = await encryptPrivateKey(pkcs8, nextMaster.masterWrappingKey);
  pkcs8.fill(0);

  // Re-import non-extractable runtime private key
  const runtimePrivateKey = await decryptPrivateKey(
    reEncrypted.ciphertext,
    reEncrypted.iv,
    nextMaster.masterWrappingKey,
    false
  );

  return {
    privateKey: runtimePrivateKey,
    payload: {
      username: username.trim(),
      recoveryAuthKey: recoveryKeys.recoveryAuthKeyB64,
      kdfSalt,
      kdfIterations: iterations,
      authKey: nextMaster.authKeyB64,
      encryptedPrivateKey: reEncrypted.ciphertext,
      privateKeyIv: reEncrypted.iv,
    },
  };
}
