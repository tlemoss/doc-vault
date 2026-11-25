import { describe, expect, it } from 'vitest';
import {
  createRecoveryResetBundle,
  createRegistrationBundle,
  decryptBinary,
  decryptJson,
  decryptPrivateKey,
  deriveMasterKeys,
  encryptBinary,
  encryptJson,
  generateAesKey,
  unwrapFileKey,
  unwrapTabKeyWithPrivateKey,
  wrapFileKey,
  wrapTabKeyForPublicKey,
} from './engine';

// Use lower iterations inside unit tests to keep test runtime fast while exercising identical primitives
const TEST_ITERATIONS = 100_000;

describe('Zero-Knowledge Crypto Engine', () => {
  it('derives independent authKey and masterWrappingKey and rejects wrong passwords', async () => {
    const bundle = await createRegistrationBundle(
      'thiago',
      'SenhaMestreSuperForte!2026',
      TEST_ITERATIONS
    );

    // Correct password unlocks RSA private key
    const derived = await deriveMasterKeys(
      'SenhaMestreSuperForte!2026',
      bundle.payload.kdfSalt,
      TEST_ITERATIONS
    );
    expect(derived.authKeyB64).toBe(bundle.payload.authKey);

    const unlockedPriv = await decryptPrivateKey(
      bundle.payload.encryptedPrivateKey,
      bundle.payload.privateKeyIv,
      derived.masterWrappingKey
    );
    expect(unlockedPriv.type).toBe('private');

    // Wrong password yields different authKey and fails AES-GCM private key decryption
    const wrong = await deriveMasterKeys(
      'SenhaErradaQualquer123',
      bundle.payload.kdfSalt,
      TEST_ITERATIONS
    );
    expect(wrong.authKeyB64).not.toBe(bundle.payload.authKey);
    await expect(
      decryptPrivateKey(
        bundle.payload.encryptedPrivateKey,
        bundle.payload.privateKeyIv,
        wrong.masterWrappingKey
      )
    ).rejects.toThrow();
  });

  it('shares a tab key securely via RSA-OAEP between Alice and Bob while isolating Eve', async () => {
    const alice = await createRegistrationBundle('alice', 'AlicePassword#2026', TEST_ITERATIONS);
    const bob = await createRegistrationBundle('bob', 'BobPassword#2026', TEST_ITERATIONS);
    const eve = await createRegistrationBundle('eve', 'EvePassword#2026', TEST_ITERATIONS);

    const tabKey = await generateAesKey();
    const secretPayload = { descricao: 'Salário Mensal', valor: 15420.5, pago: true };
    const encryptedRow = await encryptJson(secretPayload, tabKey);

    // Ciphertext never contains plaintext
    expect(encryptedRow.ciphertext).not.toContain('Salário');
    expect(encryptedRow.ciphertext).not.toContain('15420');

    // Alice wraps tabKey for Bob using Bob's public key
    const wrappedForBob = await wrapTabKeyForPublicKey(tabKey, bob.payload.publicKey);

    // Bob unwraps and decrypts cleanly
    const bobTabKey = await unwrapTabKeyWithPrivateKey(wrappedForBob, bob.privateKey);
    const decryptedByBob = await decryptJson<typeof secretPayload>(
      encryptedRow.ciphertext,
      encryptedRow.iv,
      bobTabKey
    );
    expect(decryptedByBob).toEqual(secretPayload);

    // Eve cannot unwrap Bob's wrapped tab key
    await expect(unwrapTabKeyWithPrivateKey(wrappedForBob, eve.privateKey)).rejects.toThrow();
  });

  it('encrypts binary files with per-file wrapped keys and detects ciphertext tampering', async () => {
    const tabKey = await generateAesKey();
    const fileKey = await generateAesKey();
    const { wrappedFileKey, fileKeyIv } = await wrapFileKey(fileKey, tabKey);

    const originalBytes = new TextEncoder().encode('Comprovante IRPF 2026 — CPF 000.000.000-00');
    const { ciphertext, iv } = await encryptBinary(originalBytes.buffer, fileKey);

    // Ciphertext must not contain plaintext bytes
    expect(new TextDecoder().decode(ciphertext)).not.toContain('IRPF');

    // Decrypt using unwrapped file key
    const unwrappedKey = await unwrapFileKey(wrappedFileKey, fileKeyIv, tabKey);
    const decrypted = await decryptBinary(ciphertext.slice().buffer, iv, unwrappedKey);
    expect(new Uint8Array(decrypted)).toEqual(originalBytes);

    // Tampering with even 1 bit must fail AES-GCM authentication
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;
    await expect(decryptBinary(tampered.buffer, iv, unwrappedKey)).rejects.toThrow();
  });

  it('recovers the exact same RSA private key via Recovery Key after password reset', async () => {
    const orig = await createRegistrationBundle('owner', 'SenhaOriginal!2026', TEST_ITERATIONS);

    // Create a tab wrapped with original public key
    const tabKey = await generateAesKey();
    const wrappedTabKey = await wrapTabKeyForPublicKey(tabKey, orig.payload.publicKey);
    const secret = await encryptJson({ title: 'Imposto de Renda' }, tabKey);

    // Reset password using Recovery Key
    const reset = await createRecoveryResetBundle(
      'owner',
      orig.recoveryKey,
      orig.payload.recoverySalt,
      orig.payload.recoveryEncryptedPrivateKey,
      orig.payload.recoveryIv,
      'NovaSenhaMestre!2026',
      TEST_ITERATIONS
    );

    // New password unlocks private key and STILL decrypts existing tabs!
    const nextDerived = await deriveMasterKeys(
      'NovaSenhaMestre!2026',
      reset.payload.kdfSalt,
      TEST_ITERATIONS
    );
    const unlockedAfterReset = await decryptPrivateKey(
      reset.payload.encryptedPrivateKey,
      reset.payload.privateKeyIv,
      nextDerived.masterWrappingKey
    );

    const recoveredTabKey = await unwrapTabKeyWithPrivateKey(wrappedTabKey, unlockedAfterReset);
    const decrypted = await decryptJson<{ title: string }>(
      secret.ciphertext,
      secret.iv,
      recoveredTabKey
    );
    expect(decrypted.title).toBe('Imposto de Renda');
  });
});
