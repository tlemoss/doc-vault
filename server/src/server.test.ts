import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildApp } from './app.js';

function fakeRegistration(username: string) {
  return {
    username,
    kdfSalt: crypto.randomBytes(16).toString('base64'),
    kdfIterations: 600000,
    authKey: crypto.randomBytes(32).toString('base64'),
    publicKey: crypto.randomBytes(200).toString('base64'),
    publicKeyFingerprint: 'AAAA:BBBB:CCCC:DDDD:EEEE:FFFF:1111:2222',
    encryptedPrivateKey: crypto.randomBytes(300).toString('base64'),
    privateKeyIv: crypto.randomBytes(12).toString('base64'),
    recoveryEncryptedPrivateKey: crypto.randomBytes(300).toString('base64'),
    recoveryIv: crypto.randomBytes(12).toString('base64'),
    recoverySalt: crypto.randomBytes(16).toString('base64'),
    recoveryAuthKey: crypto.randomBytes(32).toString('base64'),
  };
}

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  assert.ok(setCookieHeader, 'Expected Set-Cookie header');
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return raw.split(';')[0];
}

describe('Documents Vault Backend — Access Control, Quotas & Zero-Knowledge Storage', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  const built = await buildApp(
    {
      dataDir: tmpDir,
      defaultQuotaBytes: 1024 * 1024 * 1024, // 1 GB
      cookieSecure: false,
    },
    { logger: false, disableRateLimit: true }
  );
  const { app, db } = built;

  after(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enforces single-setup, invite-only registration, per-tab RBAC, key rotation, quota limits, and zero plaintext on host', async () => {
    // 1. Initial status is uninitialized
    const status0 = await app.inject({ method: 'GET', url: '/api/auth/status' });
    assert.equal(status0.statusCode, 200);
    assert.equal(status0.json().initialized, false);
    assert.equal(status0.json().defaultQuotaBytes, 1024 * 1024 * 1024);

    // 2. Setup first admin account
    const adminReg = fakeRegistration('admin_user');
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: adminReg,
    });
    assert.equal(setupRes.statusCode, 201);
    const adminCookie = extractCookie(setupRes.headers['set-cookie']);
    const adminId = setupRes.json().user.id as string;
    assert.equal(setupRes.json().user.role, 'admin');
    assert.equal(setupRes.json().user.quotaBytes, 1024 * 1024 * 1024);

    // Second setup attempt must be rejected
    const setupAgain = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: fakeRegistration('hacker'),
    });
    assert.equal(setupAgain.statusCode, 409);

    // 3. Admin creates an invite for User B
    const inviteRes = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { cookie: adminCookie },
      payload: {
        username: 'maria',
        role: 'user',
        quotaBytes: 2 * 1024 * 1024, // 2 MB for quota test
        expiresInHours: 24,
      },
    });
    assert.equal(inviteRes.statusCode, 201);
    const inviteToken = inviteRes.json().invite.token as string;

    // User B registers with invite
    const mariaReg = fakeRegistration('maria');
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...mariaReg, inviteToken },
    });
    assert.equal(regRes.statusCode, 201);
    const mariaCookie = extractCookie(regRes.headers['set-cookie']);
    const mariaId = regRes.json().user.id as string;

    // Invite cannot be reused
    const reuseRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...fakeRegistration('maria2'), inviteToken },
    });
    assert.equal(reuseRes.statusCode, 400);

    // Non-admin cannot access admin endpoints
    const nonAdmin = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: mariaCookie },
    });
    assert.equal(nonAdmin.statusCode, 403);

    // 4. Admin creates a Documents tab and uploads an encrypted file blob
    const docTabRes = await app.inject({
      method: 'POST',
      url: '/api/tabs',
      headers: { cookie: adminCookie },
      payload: {
        type: 'documents',
        encryptedMeta: crypto.randomBytes(48).toString('base64'),
        metaIv: crypto.randomBytes(12).toString('base64'),
        wrappedTabKey: crypto.randomBytes(128).toString('base64'),
      },
    });
    assert.equal(docTabRes.statusCode, 201);
    const docTabId = docTabRes.json().tab.id as string;

    const createFileRes = await app.inject({
      method: 'POST',
      url: `/api/tabs/${docTabId}/documents`,
      headers: { cookie: adminCookie },
      payload: {
        kind: 'file',
        encryptedMeta: crypto.randomBytes(64).toString('base64'),
        metaIv: crypto.randomBytes(12).toString('base64'),
        wrappedFileKey: crypto.randomBytes(48).toString('base64'),
        fileKeyIv: crypto.randomBytes(12).toString('base64'),
        blobIv: crypto.randomBytes(12).toString('base64'),
        expectedBlobSize: 256,
      },
    });
    assert.equal(createFileRes.statusCode, 201);
    const fileDocId = createFileRes.json().document.id as string;

    const encryptedBlobBytes = crypto.randomBytes(256);
    const uploadRes = await app.inject({
      method: 'PUT',
      url: `/api/tabs/${docTabId}/documents/${fileDocId}/blob`,
      headers: {
        cookie: adminCookie,
        'content-type': 'application/octet-stream',
        'x-blob-iv': crypto.randomBytes(12).toString('base64'),
      },
      payload: encryptedBlobBytes,
    });
    assert.equal(uploadRes.statusCode, 200);
    assert.equal(uploadRes.json().blobSize, 256);

    // Verify blob on disk uses opaque UUID .enc name and exact encrypted bytes
    const blobFiles = fs.readdirSync(path.join(tmpDir, 'blobs'));
    assert.equal(blobFiles.length, 1);
    assert.match(blobFiles[0], /^[0-9a-f-]{36}\.enc$/);
    const diskBytes = fs.readFileSync(path.join(tmpDir, 'blobs', blobFiles[0]));
    assert.deepEqual(diskBytes, encryptedBlobBytes);

    // 5. Admin creates a Structured Table tab + inserts an encrypted financial row
    const tableTabRes = await app.inject({
      method: 'POST',
      url: '/api/tabs',
      headers: { cookie: adminCookie },
      payload: {
        type: 'table',
        encryptedMeta: crypto.randomBytes(48).toString('base64'),
        metaIv: crypto.randomBytes(12).toString('base64'),
        encryptedSchema: crypto.randomBytes(96).toString('base64'),
        schemaIv: crypto.randomBytes(12).toString('base64'),
        wrappedTabKey: crypto.randomBytes(128).toString('base64'),
      },
    });
    assert.equal(tableTabRes.statusCode, 201);
    const tableTabId = tableTabRes.json().tab.id as string;

    const rowRes = await app.inject({
      method: 'POST',
      url: `/api/tabs/${tableTabId}/rows`,
      headers: { cookie: adminCookie },
      payload: {
        encryptedData: crypto.randomBytes(80).toString('base64'),
        dataIv: crypto.randomBytes(12).toString('base64'),
      },
    });
    assert.equal(rowRes.statusCode, 201);
    const rowId = rowRes.json().row.id as string;

    // 6. RBAC isolation: Maria has NO access to Admin's tabs yet
    const mariaReadDocs = await app.inject({
      method: 'GET',
      url: `/api/tabs/${docTabId}/documents`,
      headers: { cookie: mariaCookie },
    });
    assert.equal(mariaReadDocs.statusCode, 403);

    const mariaReadRows = await app.inject({
      method: 'GET',
      url: `/api/tabs/${tableTabId}/rows`,
      headers: { cookie: mariaCookie },
    });
    assert.equal(mariaReadRows.statusCode, 403);

    // 7. Admin shares tableTab with Maria as VIEWER
    const shareRes = await app.inject({
      method: 'POST',
      url: `/api/tabs/${tableTabId}/access`,
      headers: { cookie: adminCookie },
      payload: {
        userId: mariaId,
        role: 'viewer',
        wrappedTabKey: crypto.randomBytes(128).toString('base64'),
      },
    });
    assert.equal(shareRes.statusCode, 200);

    // Maria can now read rows, but CANNOT write or delete
    const mariaCanRead = await app.inject({
      method: 'GET',
      url: `/api/tabs/${tableTabId}/rows`,
      headers: { cookie: mariaCookie },
    });
    assert.equal(mariaCanRead.statusCode, 200);
    assert.equal(mariaCanRead.json().rows.length, 1);

    const mariaCannotWrite = await app.inject({
      method: 'POST',
      url: `/api/tabs/${tableTabId}/rows`,
      headers: { cookie: mariaCookie },
      payload: {
        encryptedData: crypto.randomBytes(64).toString('base64'),
        dataIv: crypto.randomBytes(12).toString('base64'),
      },
    });
    assert.equal(mariaCannotWrite.statusCode, 403);

    // 8. Admin upgrades Maria to EDITOR -> Maria can insert rows, still cannot delete tab
    await app.inject({
      method: 'POST',
      url: `/api/tabs/${tableTabId}/access`,
      headers: { cookie: adminCookie },
      payload: {
        userId: mariaId,
        role: 'editor',
        wrappedTabKey: crypto.randomBytes(128).toString('base64'),
      },
    });
    const mariaCanWrite = await app.inject({
      method: 'POST',
      url: `/api/tabs/${tableTabId}/rows`,
      headers: { cookie: mariaCookie },
      payload: {
        encryptedData: crypto.randomBytes(64).toString('base64'),
        dataIv: crypto.randomBytes(12).toString('base64'),
      },
    });
    assert.equal(mariaCanWrite.statusCode, 201);
    const mariaRowId = mariaCanWrite.json().row.id as string;

    const mariaCannotDeleteTab = await app.inject({
      method: 'DELETE',
      url: `/api/tabs/${tableTabId}`,
      headers: { cookie: mariaCookie },
    });
    assert.equal(mariaCannotDeleteTab.statusCode, 403);

    // 9. Admin revokes Maria and rotates tab key atomically
    const revokeRes = await app.inject({
      method: 'DELETE',
      url: `/api/tabs/${tableTabId}/access/${mariaId}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(revokeRes.statusCode, 200);

    const rotateRes = await app.inject({
      method: 'POST',
      url: `/api/tabs/${tableTabId}/rotate-key`,
      headers: { cookie: adminCookie },
      payload: {
        encryptedMeta: crypto.randomBytes(48).toString('base64'),
        metaIv: crypto.randomBytes(12).toString('base64'),
        encryptedSchema: crypto.randomBytes(96).toString('base64'),
        schemaIv: crypto.randomBytes(12).toString('base64'),
        memberKeys: [
          { userId: adminId, wrappedTabKey: crypto.randomBytes(128).toString('base64') },
        ],
        documents: [],
        rows: [
          {
            id: rowId,
            encryptedData: crypto.randomBytes(80).toString('base64'),
            dataIv: crypto.randomBytes(12).toString('base64'),
          },
          {
            id: mariaRowId,
            encryptedData: crypto.randomBytes(64).toString('base64'),
            dataIv: crypto.randomBytes(12).toString('base64'),
          },
        ],
      },
    });
    assert.equal(rotateRes.statusCode, 200);

    const tabAfterRotate = db
      .prepare('SELECT key_version FROM tabs WHERE id = ?')
      .get(tableTabId) as { key_version: number };
    assert.equal(Number(tabAfterRotate.key_version), 2);

    // Maria is locked out again
    const mariaLockedOut = await app.inject({
      method: 'GET',
      url: `/api/tabs/${tableTabId}/rows`,
      headers: { cookie: mariaCookie },
    });
    assert.equal(mariaLockedOut.statusCode, 403);

    // 10. Quota enforcement: Maria has 2 MB quota; trying to store a 2.5 MB file must fail with 413
    const mariaTabRes = await app.inject({
      method: 'POST',
      url: '/api/tabs',
      headers: { cookie: mariaCookie },
      payload: {
        type: 'documents',
        encryptedMeta: crypto.randomBytes(48).toString('base64'),
        metaIv: crypto.randomBytes(12).toString('base64'),
        wrappedTabKey: crypto.randomBytes(128).toString('base64'),
      },
    });
    const mariaTabId = mariaTabRes.json().tab.id as string;

    const overQuotaRes = await app.inject({
      method: 'POST',
      url: `/api/tabs/${mariaTabId}/documents`,
      headers: { cookie: mariaCookie },
      payload: {
        kind: 'file',
        encryptedMeta: crypto.randomBytes(64).toString('base64'),
        metaIv: crypto.randomBytes(12).toString('base64'),
        wrappedFileKey: crypto.randomBytes(48).toString('base64'),
        fileKeyIv: crypto.randomBytes(12).toString('base64'),
        blobIv: crypto.randomBytes(12).toString('base64'),
        expectedBlobSize: 3 * 1024 * 1024,
      },
    });
    assert.equal(overQuotaRes.statusCode, 413);

    // 11. Recovery reset rejects invalid recoveryAuthKey and accepts valid one
    const badRecovery = await app.inject({
      method: 'POST',
      url: '/api/auth/recovery/reset',
      payload: {
        username: 'maria',
        recoveryAuthKey: crypto.randomBytes(32).toString('base64'),
        kdfSalt: crypto.randomBytes(16).toString('base64'),
        kdfIterations: 600000,
        authKey: crypto.randomBytes(32).toString('base64'),
        encryptedPrivateKey: crypto.randomBytes(300).toString('base64'),
        privateKeyIv: crypto.randomBytes(12).toString('base64'),
      },
    });
    assert.equal(badRecovery.statusCode, 401);

    const newAuthKey = crypto.randomBytes(32).toString('base64');
    const goodRecovery = await app.inject({
      method: 'POST',
      url: '/api/auth/recovery/reset',
      payload: {
        username: 'maria',
        recoveryAuthKey: mariaReg.recoveryAuthKey,
        kdfSalt: crypto.randomBytes(16).toString('base64'),
        kdfIterations: 600000,
        authKey: newAuthKey,
        encryptedPrivateKey: crypto.randomBytes(300).toString('base64'),
        privateKeyIv: crypto.randomBytes(12).toString('base64'),
      },
    });
    assert.equal(goodRecovery.statusCode, 200);

    // Maria's old session cookie was invalidated by recovery reset
    const oldSessionCheck = await app.inject({
      method: 'GET',
      url: '/api/tabs',
      headers: { cookie: mariaCookie },
    });
    assert.equal(oldSessionCheck.statusCode, 401);
  });
});
