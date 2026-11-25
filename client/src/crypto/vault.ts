import { api } from '../api/client';
import type {
  CellValue,
  DecryptedDocument,
  DecryptedTab,
  DecryptedTableRow,
  DocumentMeta,
  EncryptedDocument,
  EncryptedTab,
  EncryptedTableRow,
  TabMeta,
  TableSchema,
  TabType,
} from '../types';
import {
  decryptBinary,
  decryptJson,
  decryptText,
  encryptBinary,
  encryptJson,
  encryptText,
  generateAesKey,
  unwrapFileKey,
  unwrapTabKeyWithPrivateKey,
  wrapFileKey,
  wrapTabKeyForPublicKey,
} from './engine';

export function defaultTableSchema(): TableSchema {
  return {
    columns: [
      { id: crypto.randomUUID(), name: 'Data', type: 'date' },
      { id: crypto.randomUUID(), name: 'Descrição', type: 'text' },
      {
        id: crypto.randomUUID(),
        name: 'Categoria',
        type: 'select',
        options: ['Moradia', 'Alimentação', 'Transporte', 'Investimentos', 'Renda', 'Outros'],
      },
      { id: crypto.randomUUID(), name: 'Valor', type: 'currency', currency: 'BRL' },
      { id: crypto.randomUUID(), name: 'Pago', type: 'checkbox' },
    ],
  };
}

export async function decryptTabRecord(
  encTab: EncryptedTab,
  userPrivateKey: CryptoKey
): Promise<DecryptedTab> {
  const tabKey = await unwrapTabKeyWithPrivateKey(encTab.wrappedTabKey, userPrivateKey);
  const meta = await decryptJson<TabMeta>(encTab.encryptedMeta, encTab.metaIv, tabKey);
  let schema: TableSchema | null = null;
  if (encTab.type === 'table' && encTab.encryptedSchema && encTab.schemaIv) {
    schema = await decryptJson<TableSchema>(
      encTab.encryptedSchema,
      encTab.schemaIv,
      tabKey
    );
  }
  return {
    id: encTab.id,
    type: encTab.type,
    meta,
    schema,
    keyVersion: encTab.keyVersion,
    role: encTab.role,
    memberCount: encTab.memberCount,
    createdAt: encTab.createdAt,
    updatedAt: encTab.updatedAt,
    tabKey,
  };
}

export async function createEncryptedTab(params: {
  type: TabType;
  meta: TabMeta;
  schema?: TableSchema | null;
  userPublicKeyB64: string;
}): Promise<DecryptedTab> {
  const tabKey = await generateAesKey();
  const wrappedTabKey = await wrapTabKeyForPublicKey(tabKey, params.userPublicKeyB64);
  const encMeta = await encryptJson(params.meta, tabKey);

  let encSchema: { ciphertext: string; iv: string } | null = null;
  const effectiveSchema =
    params.type === 'table' ? (params.schema ?? defaultTableSchema()) : null;
  if (effectiveSchema) {
    encSchema = await encryptJson(effectiveSchema, tabKey);
  }

  const { tab } = await api.tabs.create({
    type: params.type,
    encryptedMeta: encMeta.ciphertext,
    metaIv: encMeta.iv,
    encryptedSchema: encSchema?.ciphertext ?? null,
    schemaIv: encSchema?.iv ?? null,
    wrappedTabKey,
  });

  return {
    id: tab.id,
    type: tab.type,
    meta: params.meta,
    schema: effectiveSchema,
    keyVersion: tab.keyVersion,
    role: tab.role,
    memberCount: tab.memberCount,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
    tabKey,
  };
}

export async function decryptDocumentRecord(
  doc: EncryptedDocument,
  tabKey: CryptoKey
): Promise<DecryptedDocument> {
  const meta = await decryptJson<DocumentMeta>(doc.encryptedMeta, doc.metaIv, tabKey);
  let content: string | null = null;
  if (doc.kind === 'note' && doc.encryptedContent !== null && doc.contentIv) {
    content = await decryptText(doc.encryptedContent, doc.contentIv, tabKey);
  }
  return {
    id: doc.id,
    tabId: doc.tabId,
    kind: doc.kind,
    meta,
    content,
    wrappedFileKey: doc.wrappedFileKey,
    fileKeyIv: doc.fileKeyIv,
    blobIv: doc.blobIv,
    blobSize: doc.blobSize,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function uploadEncryptedFile(params: {
  tabId: string;
  tabKey: CryptoKey;
  file: File;
  tags: string[];
  summary?: string;
}): Promise<{ doc: DecryptedDocument; usedBytes: number }> {
  const fileKey = await generateAesKey();
  const { wrappedFileKey, fileKeyIv } = await wrapFileKey(fileKey, params.tabKey);
  const rawBuffer = await params.file.arrayBuffer();
  const { ciphertext, iv: blobIv } = await encryptBinary(rawBuffer, fileKey);

  const meta: DocumentMeta = {
    name: params.file.name,
    mimeType: params.file.type || 'application/octet-stream',
    originalSize: params.file.size,
    tags: params.tags,
    summary: params.summary?.trim() || undefined,
  };
  const encMeta = await encryptJson(meta, params.tabKey);

  const created = await api.documents.create(params.tabId, {
    kind: 'file',
    encryptedMeta: encMeta.ciphertext,
    metaIv: encMeta.iv,
    wrappedFileKey,
    fileKeyIv,
    blobIv,
    expectedBlobSize: ciphertext.byteLength,
  });

  try {
    const uploaded = await api.documents.uploadBlob(
      params.tabId,
      created.document.id,
      ciphertext,
      blobIv
    );

    return {
      usedBytes: uploaded.usedBytes,
      doc: {
        id: created.document.id,
        tabId: params.tabId,
        kind: 'file',
        meta,
        content: null,
        wrappedFileKey,
        fileKeyIv,
        blobIv,
        blobSize: uploaded.blobSize,
        createdAt: created.document.createdAt,
        updatedAt: uploaded.updatedAt,
      },
    };
  } catch (err) {
    // Clean up pending record if blob upload fails
    await api.documents.delete(params.tabId, created.document.id).catch(() => {});
    throw err;
  }
}

export async function downloadAndDecryptFile(
  doc: DecryptedDocument,
  tabKey: CryptoKey
): Promise<Blob> {
  if (!doc.wrappedFileKey || !doc.fileKeyIv || !doc.blobIv) {
    throw new Error('Metadados criptográficos do arquivo incompletos.');
  }
  const encryptedBytes = await api.documents.downloadBlob(doc.tabId, doc.id);
  const fileKey = await unwrapFileKey(doc.wrappedFileKey, doc.fileKeyIv, tabKey);
  const decryptedBuffer = await decryptBinary(encryptedBytes, doc.blobIv, fileKey);
  return new Blob([decryptedBuffer], {
    type: doc.meta.mimeType || 'application/octet-stream',
  });
}

export async function createEncryptedNote(params: {
  tabId: string;
  tabKey: CryptoKey;
  title: string;
  content: string;
  tags: string[];
}): Promise<{ doc: DecryptedDocument; usedBytes: number }> {
  const meta: DocumentMeta = {
    name: params.title.trim(),
    tags: params.tags,
  };
  const [encMeta, encContent] = await Promise.all([
    encryptJson(meta, params.tabKey),
    encryptText(params.content, params.tabKey),
  ]);

  const res = await api.documents.create(params.tabId, {
    kind: 'note',
    encryptedMeta: encMeta.ciphertext,
    metaIv: encMeta.iv,
    encryptedContent: encContent.ciphertext,
    contentIv: encContent.iv,
  });

  return {
    usedBytes: res.usedBytes,
    doc: {
      id: res.document.id,
      tabId: params.tabId,
      kind: 'note',
      meta,
      content: params.content,
      wrappedFileKey: null,
      fileKeyIv: null,
      blobIv: null,
      blobSize: 0,
      createdAt: res.document.createdAt,
      updatedAt: res.document.updatedAt,
    },
  };
}

export async function decryptTableRow(
  row: EncryptedTableRow,
  tabKey: CryptoKey
): Promise<DecryptedTableRow> {
  const values = await decryptJson<Record<string, CellValue>>(
    row.encryptedData,
    row.dataIv,
    tabKey
  );
  return {
    id: row.id,
    tabId: row.tabId,
    sortOrder: row.sortOrder,
    values,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Rotates a tab's AES-256-GCM key:
 * - Generates a fresh tabKey
 * - Re-wraps tabKey for every remaining authorized member using their RSA-OAEP public key
 * - Re-encrypts tab metadata & schema
 * - Re-wraps every file's per-file key (without touching encrypted blobs on disk!)
 * - Re-encrypts all notes and structured table rows
 * - Commits everything atomically on the server
 */
export async function rotateTabKey(tab: DecryptedTab): Promise<CryptoKey> {
  const newTabKey = await generateAesKey();
  const { members } = await api.tabs.listAccess(tab.id);

  const memberKeys = await Promise.all(
    members.map(async (m) => ({
      userId: m.userId,
      wrappedTabKey: await wrapTabKeyForPublicKey(newTabKey, m.publicKey),
    }))
  );

  const encMeta = await encryptJson(tab.meta, newTabKey);
  const encSchema = tab.schema ? await encryptJson(tab.schema, newTabKey) : null;

  const rotatedDocs: Array<{
    id: string;
    encryptedMeta: string;
    metaIv: string;
    encryptedContent?: string | null;
    contentIv?: string | null;
    wrappedFileKey?: string | null;
    fileKeyIv?: string | null;
  }> = [];

  const rotatedRows: Array<{
    id: string;
    encryptedData: string;
    dataIv: string;
  }> = [];

  if (tab.type === 'documents') {
    const { documents } = await api.documents.list(tab.id);
    for (const doc of documents) {
      const decMeta = await decryptJson<DocumentMeta>(
        doc.encryptedMeta,
        doc.metaIv,
        tab.tabKey
      );
      const newEncMeta = await encryptJson(decMeta, newTabKey);

      if (doc.kind === 'note') {
        const plainContent =
          doc.encryptedContent !== null && doc.contentIv
            ? await decryptText(doc.encryptedContent, doc.contentIv, tab.tabKey)
            : '';
        const newEncContent = await encryptText(plainContent, newTabKey);
        rotatedDocs.push({
          id: doc.id,
          encryptedMeta: newEncMeta.ciphertext,
          metaIv: newEncMeta.iv,
          encryptedContent: newEncContent.ciphertext,
          contentIv: newEncContent.iv,
          wrappedFileKey: null,
          fileKeyIv: null,
        });
      } else {
        let newWrappedFileKey: string | null = null;
        let newFileKeyIv: string | null = null;
        if (doc.wrappedFileKey && doc.fileKeyIv) {
          const fileKey = await unwrapFileKey(
            doc.wrappedFileKey,
            doc.fileKeyIv,
            tab.tabKey
          );
          const wrapped = await wrapFileKey(fileKey, newTabKey);
          newWrappedFileKey = wrapped.wrappedFileKey;
          newFileKeyIv = wrapped.fileKeyIv;
        }
        rotatedDocs.push({
          id: doc.id,
          encryptedMeta: newEncMeta.ciphertext,
          metaIv: newEncMeta.iv,
          encryptedContent: null,
          contentIv: null,
          wrappedFileKey: newWrappedFileKey,
          fileKeyIv: newFileKeyIv,
        });
      }
    }
  } else {
    const { rows } = await api.tables.listRows(tab.id);
    for (const row of rows) {
      const decValues = await decryptJson<Record<string, CellValue>>(
        row.encryptedData,
        row.dataIv,
        tab.tabKey
      );
      const newEnc = await encryptJson(decValues, newTabKey);
      rotatedRows.push({
        id: row.id,
        encryptedData: newEnc.ciphertext,
        dataIv: newEnc.iv,
      });
    }
  }

  await api.tabs.rotateKey(tab.id, {
    encryptedMeta: encMeta.ciphertext,
    metaIv: encMeta.iv,
    encryptedSchema: encSchema?.ciphertext ?? null,
    schemaIv: encSchema?.iv ?? null,
    memberKeys,
    documents: rotatedDocs,
    rows: rotatedRows,
  });

  return newTabKey;
}
