export type UserRole = 'admin' | 'user';
export type TabType = 'documents' | 'table';
export type TabRole = 'owner' | 'editor' | 'viewer';

export interface CurrentUser {
  id: string;
  username: string;
  role: UserRole;
  quotaBytes: number;
  usedBytes: number;
  kdfSalt: string;
  kdfIterations: number;
  publicKey: string;
  publicKeyFingerprint: string;
  encryptedPrivateKey: string;
  privateKeyIv: string;
}

export interface DirectoryUser {
  id: string;
  username: string;
  publicKey: string;
  publicKeyFingerprint: string;
}

export interface AdminUser extends DirectoryUser {
  role: UserRole;
  quotaBytes: number;
  usedBytes: number;
  isActive: boolean;
  createdAt: string;
}

export interface AdminInvite {
  tokenHash: string;
  username: string | null;
  role: UserRole;
  quotaBytes: number;
  expiresAt: string;
  createdAt: string;
  createdBy: string | null;
  usedBy: string | null;
}

export interface TabMeta {
  title: string;
  description: string;
  icon: string;
}

export type ColumnType = 'text' | 'number' | 'currency' | 'date' | 'select' | 'checkbox';

export interface TableColumn {
  id: string;
  name: string;
  type: ColumnType;
  currency?: string;
  options?: string[];
}

export interface TableSchema {
  columns: TableColumn[];
}

export interface EncryptedTab {
  id: string;
  type: TabType;
  encryptedMeta: string;
  metaIv: string;
  encryptedSchema: string | null;
  schemaIv: string | null;
  keyVersion: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  role: TabRole;
  wrappedTabKey: string;
  memberCount: number;
}

export interface DecryptedTab {
  id: string;
  type: TabType;
  meta: TabMeta;
  schema: TableSchema | null;
  keyVersion: number;
  role: TabRole;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  tabKey: CryptoKey;
}

export interface TabMember {
  userId: string;
  username: string;
  role: TabRole;
  publicKey: string;
  publicKeyFingerprint: string;
  grantedAt: string;
}

export interface EncryptedDocument {
  id: string;
  tabId: string;
  kind: 'file' | 'note';
  encryptedMeta: string;
  metaIv: string;
  encryptedContent: string | null;
  contentIv: string | null;
  wrappedFileKey: string | null;
  fileKeyIv: string | null;
  blobIv: string | null;
  blobSize: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentMeta {
  name: string;
  mimeType?: string;
  originalSize?: number;
  tags: string[];
  summary?: string;
}

export interface DecryptedDocument {
  id: string;
  tabId: string;
  kind: 'file' | 'note';
  meta: DocumentMeta;
  content: string | null;
  wrappedFileKey: string | null;
  fileKeyIv: string | null;
  blobIv: string | null;
  blobSize: number;
  createdAt: string;
  updatedAt: string;
}

export interface EncryptedTableRow {
  id: string;
  tabId: string;
  sortOrder: number;
  encryptedData: string;
  dataIv: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type CellValue = string | number | boolean | null;

export interface DecryptedTableRow {
  id: string;
  tabId: string;
  sortOrder: number;
  values: Record<string, CellValue>;
  createdAt: string;
  updatedAt: string;
}
