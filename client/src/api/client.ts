import type {
  AdminInvite,
  AdminUser,
  CurrentUser,
  DirectoryUser,
  EncryptedDocument,
  EncryptedTab,
  EncryptedTableRow,
  TabMember,
  TabRole,
  TabType,
  UserRole,
} from '../types';
import type { RegistrationPayload } from '../crypto/engine';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof Uint8Array)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let msg = `Erro HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // ignore non-json error body
    }
    throw new ApiError(msg, res.status);
  }

  return (await res.json()) as T;
}

export const api = {
  auth: {
    status: () =>
      requestJson<{
        initialized: boolean;
        user: CurrentUser | null;
        maxFileSizeBytes: number;
        defaultQuotaBytes: number;
      }>('/api/auth/status'),

    setup: (payload: RegistrationPayload) =>
      requestJson<{ user: CurrentUser }>('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),

    checkInvite: (token: string) =>
      requestJson<{
        valid: boolean;
        username: string | null;
        role: UserRole;
        quotaBytes: number;
        expiresAt: string;
      }>(`/api/auth/invite/${encodeURIComponent(token)}`),

    register: (payload: RegistrationPayload & { inviteToken: string }) =>
      requestJson<{ user: CurrentUser }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),

    loginChallenge: (username: string) =>
      requestJson<{ kdfSalt: string; kdfIterations: number }>(
        '/api/auth/login/challenge',
        {
          method: 'POST',
          body: JSON.stringify({ username }),
        }
      ),

    login: (username: string, authKey: string) =>
      requestJson<{ user: CurrentUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, authKey }),
      }),

    logout: () =>
      requestJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

    recoveryChallenge: (username: string) =>
      requestJson<{
        recoverySalt: string;
        recoveryEncryptedPrivateKey: string;
        recoveryIv: string;
        publicKey: string;
      }>('/api/auth/recovery/challenge', {
        method: 'POST',
        body: JSON.stringify({ username }),
      }),

    recoveryReset: (payload: {
      username: string;
      recoveryAuthKey: string;
      kdfSalt: string;
      kdfIterations: number;
      authKey: string;
      encryptedPrivateKey: string;
      privateKeyIv: string;
    }) =>
      requestJson<{ user: CurrentUser }>('/api/auth/recovery/reset', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  },

  users: {
    directory: () =>
      requestJson<{ users: DirectoryUser[] }>('/api/users/directory'),

    adminList: () => requestJson<{ users: AdminUser[] }>('/api/admin/users'),

    adminUpdate: (
      id: string,
      data: { quotaBytes?: number; role?: UserRole; isActive?: boolean }
    ) =>
      requestJson<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),

    adminListInvites: () =>
      requestJson<{ invites: AdminInvite[] }>('/api/admin/invites'),

    adminCreateInvite: (data: {
      username?: string;
      role: UserRole;
      quotaBytes: number;
      expiresInHours: number;
    }) =>
      requestJson<{
        invite: {
          token: string;
          tokenHash: string;
          username: string | null;
          role: UserRole;
          quotaBytes: number;
          expiresAt: string;
        };
      }>('/api/admin/invites', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    adminDeleteInvite: (tokenHash: string) =>
      requestJson<{ ok: boolean }>(
        `/api/admin/invites/${encodeURIComponent(tokenHash)}`,
        { method: 'DELETE' }
      ),
  },

  tabs: {
    list: () => requestJson<{ tabs: EncryptedTab[] }>('/api/tabs'),

    create: (payload: {
      type: TabType;
      encryptedMeta: string;
      metaIv: string;
      encryptedSchema?: string | null;
      schemaIv?: string | null;
      wrappedTabKey: string;
    }) =>
      requestJson<{ tab: EncryptedTab }>('/api/tabs', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),

    update: (
      tabId: string,
      payload: {
        encryptedMeta?: string;
        metaIv?: string;
        encryptedSchema?: string;
        schemaIv?: string;
      }
    ) =>
      requestJson<{ ok: boolean; updatedAt: string }>(
        `/api/tabs/${encodeURIComponent(tabId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        }
      ),

    delete: (tabId: string) =>
      requestJson<{ ok: boolean }>(`/api/tabs/${encodeURIComponent(tabId)}`, {
        method: 'DELETE',
      }),

    listAccess: (tabId: string) =>
      requestJson<{ members: TabMember[] }>(
        `/api/tabs/${encodeURIComponent(tabId)}/access`
      ),

    grantAccess: (
      tabId: string,
      payload: { userId: string; role: TabRole; wrappedTabKey: string }
    ) =>
      requestJson<{ ok: boolean }>(
        `/api/tabs/${encodeURIComponent(tabId)}/access`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        }
      ),

    revokeAccess: (tabId: string, userId: string) =>
      requestJson<{ ok: boolean }>(
        `/api/tabs/${encodeURIComponent(tabId)}/access/${encodeURIComponent(userId)}`,
        { method: 'DELETE' }
      ),

    rotateKey: (
      tabId: string,
      payload: {
        encryptedMeta: string;
        metaIv: string;
        encryptedSchema?: string | null;
        schemaIv?: string | null;
        memberKeys: Array<{ userId: string; wrappedTabKey: string }>;
        documents: Array<{
          id: string;
          encryptedMeta: string;
          metaIv: string;
          encryptedContent?: string | null;
          contentIv?: string | null;
          wrappedFileKey?: string | null;
          fileKeyIv?: string | null;
        }>;
        rows: Array<{
          id: string;
          encryptedData: string;
          dataIv: string;
        }>;
      }
    ) =>
      requestJson<{ ok: boolean; updatedAt: string }>(
        `/api/tabs/${encodeURIComponent(tabId)}/rotate-key`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        }
      ),
  },

  documents: {
    list: (tabId: string) =>
      requestJson<{ documents: EncryptedDocument[] }>(
        `/api/tabs/${encodeURIComponent(tabId)}/documents`
      ),

    create: (
      tabId: string,
      payload: {
        kind: 'file' | 'note';
        encryptedMeta: string;
        metaIv: string;
        encryptedContent?: string | null;
        contentIv?: string | null;
        wrappedFileKey?: string | null;
        fileKeyIv?: string | null;
        blobIv?: string | null;
        expectedBlobSize?: number;
      }
    ) =>
      requestJson<{ document: EncryptedDocument; usedBytes: number }>(
        `/api/tabs/${encodeURIComponent(tabId)}/documents`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        }
      ),

    uploadBlob: async (
      tabId: string,
      docId: string,
      encryptedBytes: Uint8Array,
      blobIv: string
    ) => {
      const res = await fetch(
        `/api/tabs/${encodeURIComponent(tabId)}/documents/${encodeURIComponent(docId)}/blob`,
        {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Blob-Iv': blobIv,
          },
          body: encryptedBytes as unknown as BodyInit,
        }
      );
      if (!res.ok) {
        let msg = `Falha no envio (${res.status})`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          // ignore
        }
        throw new ApiError(msg, res.status);
      }
      return (await res.json()) as {
        ok: boolean;
        blobSize: number;
        updatedAt: string;
        usedBytes: number;
      };
    },

    downloadBlob: async (tabId: string, docId: string): Promise<ArrayBuffer> => {
      const res = await fetch(
        `/api/tabs/${encodeURIComponent(tabId)}/documents/${encodeURIComponent(docId)}/blob`,
        { credentials: 'include' }
      );
      if (!res.ok) {
        throw new ApiError(`Falha ao baixar arquivo (${res.status})`, res.status);
      }
      return res.arrayBuffer();
    },

    update: (
      tabId: string,
      docId: string,
      payload: {
        encryptedMeta?: string;
        metaIv?: string;
        encryptedContent?: string;
        contentIv?: string;
      }
    ) =>
      requestJson<{ ok: boolean; updatedAt: string; usedBytes: number }>(
        `/api/tabs/${encodeURIComponent(tabId)}/documents/${encodeURIComponent(docId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        }
      ),

    delete: (tabId: string, docId: string) =>
      requestJson<{ ok: boolean; usedBytes: number }>(
        `/api/tabs/${encodeURIComponent(tabId)}/documents/${encodeURIComponent(docId)}`,
        { method: 'DELETE' }
      ),
  },

  tables: {
    listRows: (tabId: string) =>
      requestJson<{ rows: EncryptedTableRow[] }>(
        `/api/tabs/${encodeURIComponent(tabId)}/rows`
      ),

    createRow: (
      tabId: string,
      payload: { encryptedData: string; dataIv: string; sortOrder?: number }
    ) =>
      requestJson<{ row: EncryptedTableRow; usedBytes: number }>(
        `/api/tabs/${encodeURIComponent(tabId)}/rows`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        }
      ),

    updateRow: (
      tabId: string,
      rowId: string,
      payload: { encryptedData: string; dataIv: string; sortOrder?: number }
    ) =>
      requestJson<{ ok: boolean; updatedAt: string }>(
        `/api/tabs/${encodeURIComponent(tabId)}/rows/${encodeURIComponent(rowId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        }
      ),

    deleteRow: (tabId: string, rowId: string) =>
      requestJson<{ ok: boolean }>(
        `/api/tabs/${encodeURIComponent(tabId)}/rows/${encodeURIComponent(rowId)}`,
        { method: 'DELETE' }
      ),

    batchDeleteRows: (tabId: string, rowIds: string[]) =>
      requestJson<{ ok: boolean }>(
        `/api/tabs/${encodeURIComponent(tabId)}/rows/batch-delete`,
        {
          method: 'POST',
          body: JSON.stringify({ rowIds }),
        }
      ),
  },
};
