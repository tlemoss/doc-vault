import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  Eye,
  File,
  FileImage,
  FileText,
  Lock,
  PanelRightOpen,
  Plus,
  Search,
  Share2,
  StickyNote,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import { encryptJson, encryptText } from '../crypto/engine';
import {
  createEncryptedNote,
  decryptDocumentRecord,
  downloadAndDecryptFile,
  uploadEncryptedFile,
} from '../crypto/vault';
import type { DecryptedDocument, DecryptedTab } from '../types';
import { formatBytes, formatDateTime } from '../utils/format';

interface DocumentTabProps {
  tab: DecryptedTab;
  maxFileSizeBytes: number;
  onQuotaChanged: (usedBytes: number) => void;
  onOpenShare: () => void;
  onDeleteTab: () => void;
  onOpenMobileMenu: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'err') => void;
}

export function DocumentTab({
  tab,
  maxFileSizeBytes,
  onQuotaChanged,
  onOpenShare,
  onDeleteTab,
  onOpenMobileMenu,
  onNotify,
}: DocumentTabProps) {
  const canEdit = tab.role === 'owner' || tab.role === 'editor';
  const isOwner = tab.role === 'owner';

  const [docs, setDocs] = useState<DecryptedDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'file' | 'note'>('all');
  const [dragActive, setDragActive] = useState(false);

  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [fileTags, setFileTags] = useState('');
  const [fileSummary, setFileSummary] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [noteModal, setNoteModal] = useState<{
    id: string | null;
    title: string;
    content: string;
    tags: string;
  } | null>(null);
  const [savingNote, setSavingNote] = useState(false);

  const [preview, setPreview] = useState<{
    doc: DecryptedDocument;
    url: string | null;
    textContent: string | null;
    loading: boolean;
  } | null>(null);

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const { documents } = await api.documents.list(tab.id);
      const decrypted = await Promise.all(
        documents.map((d) => decryptDocumentRecord(d, tab.tabKey))
      );
      setDocs(decrypted);
    } catch (err: unknown) {
      onNotify(
        err instanceof Error ? err.message : 'Erro ao descriptografar documentos.',
        'err'
      );
    } finally {
      setLoading(false);
    }
  }, [tab.id, tab.tabKey, onNotify]);

  useEffect(() => {
    void loadDocs();
  }, [loadDocs]);

  useEffect(() => {
    return () => {
      if (preview?.url) {
        URL.revokeObjectURL(preview.url);
      }
    };
  }, [preview?.url]);

  function closePreview() {
    if (preview?.url) {
      URL.revokeObjectURL(preview.url);
    }
    setPreview(null);
  }

  function handleSelectFile(file: File | undefined) {
    if (!file) return;
    if (file.size > maxFileSizeBytes) {
      onNotify(
        `Arquivo excede o limite máximo de ${formatBytes(maxFileSizeBytes)}.`,
        'err'
      );
      return;
    }
    setPendingFile(file);
    setFileTags('');
    setFileSummary('');
  }

  async function handleConfirmUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingFile) return;
    setUploading(true);
    try {
      const tags = fileTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const { doc, usedBytes } = await uploadEncryptedFile({
        tabId: tab.id,
        tabKey: tab.tabKey,
        file: pendingFile,
        tags,
        summary: fileSummary,
      });
      setDocs((prev) => [doc, ...prev]);
      onQuotaChanged(usedBytes);
      setPendingFile(null);
      onNotify(`"${doc.meta.name}" criptografado e salvo com sucesso.`);
    } catch (err: unknown) {
      onNotify(
        err instanceof Error ? err.message : 'Erro ao criptografar/enviar arquivo.',
        'err'
      );
    } finally {
      setUploading(false);
    }
  }

  async function handleSaveNote(e: React.FormEvent) {
    e.preventDefault();
    if (!noteModal || !noteModal.title.trim()) return;
    setSavingNote(true);
    try {
      const tags = noteModal.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      if (!noteModal.id) {
        const { doc, usedBytes } = await createEncryptedNote({
          tabId: tab.id,
          tabKey: tab.tabKey,
          title: noteModal.title.trim(),
          content: noteModal.content,
          tags,
        });
        setDocs((prev) => [doc, ...prev]);
        onQuotaChanged(usedBytes);
        onNotify('Nota criptografada salva.');
      } else {
        const meta = { name: noteModal.title.trim(), tags };
        const [encMeta, encContent] = await Promise.all([
          encryptJson(meta, tab.tabKey),
          encryptText(noteModal.content, tab.tabKey),
        ]);
        const res = await api.documents.update(tab.id, noteModal.id, {
          encryptedMeta: encMeta.ciphertext,
          metaIv: encMeta.iv,
          encryptedContent: encContent.ciphertext,
          contentIv: encContent.iv,
        });
        setDocs((prev) =>
          prev.map((d) =>
            d.id === noteModal.id
              ? {
                  ...d,
                  meta,
                  content: noteModal.content,
                  updatedAt: res.updatedAt,
                }
              : d
          )
        );
        onQuotaChanged(res.usedBytes);
        onNotify('Nota atualizada.');
      }
      setNoteModal(null);
    } catch (err: unknown) {
      onNotify(err instanceof Error ? err.message : 'Erro ao salvar nota.', 'err');
    } finally {
      setSavingNote(false);
    }
  }

  async function handlePreviewFile(doc: DecryptedDocument) {
    if (doc.kind === 'note') {
      setNoteModal({
        id: doc.id,
        title: doc.meta.name,
        content: doc.content ?? '',
        tags: doc.meta.tags.join(', '),
      });
      return;
    }

    setPreview({ doc, url: null, textContent: null, loading: true });
    try {
      const blob = await downloadAndDecryptFile(doc, tab.tabKey);
      const mime = doc.meta.mimeType ?? '';
      if (mime.startsWith('text/') || mime === 'application/json') {
        const text = await blob.text();
        setPreview({ doc, url: null, textContent: text, loading: false });
      } else {
        const url = URL.createObjectURL(blob);
        setPreview({ doc, url, textContent: null, loading: false });
      }
    } catch (err: unknown) {
      setPreview(null);
      onNotify(
        err instanceof Error ? err.message : 'Não foi possível descriptografar o arquivo.',
        'err'
      );
    }
  }

  async function handleDownloadFile(doc: DecryptedDocument) {
    try {
      const blob = await downloadAndDecryptFile(doc, tab.tabKey);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.meta.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err: unknown) {
      onNotify(
        err instanceof Error ? err.message : 'Erro ao baixar/descriptografar arquivo.',
        'err'
      );
    }
  }

  async function handleDeleteDoc(doc: DecryptedDocument) {
    if (!window.confirm(`Excluir permanentemente "${doc.meta.name}"?`)) return;
    try {
      const res = await api.documents.delete(tab.id, doc.id);
      setDocs((prev) => prev.filter((d) => d.id !== doc.id));
      onQuotaChanged(res.usedBytes);
      onNotify('Item excluído.');
    } catch (err: unknown) {
      onNotify(err instanceof Error ? err.message : 'Erro ao excluir item.', 'err');
    }
  }

  const filteredDocs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return docs.filter((doc) => {
      if (kindFilter !== 'all' && doc.kind !== kindFilter) return false;
      if (!q) return true;
      const inName = doc.meta.name.toLowerCase().includes(q);
      const inTags = doc.meta.tags.some((t) => t.toLowerCase().includes(q));
      const inSummary = (doc.meta.summary ?? '').toLowerCase().includes(q);
      const inContent = (doc.content ?? '').toLowerCase().includes(q);
      return inName || inTags || inSummary || inContent;
    });
  }, [docs, search, kindFilter]);

  function renderIcon(doc: DecryptedDocument) {
    if (doc.kind === 'note') {
      return <StickyNote className="h-5 w-5 text-vault-warning" />;
    }
    const mime = doc.meta.mimeType ?? '';
    if (mime.startsWith('image/')) {
      return <FileImage className="h-5 w-5 text-vault-stone" />;
    }
    if (mime === 'application/pdf') {
      return <FileText className="h-5 w-5 text-vault-danger" />;
    }
    return <File className="h-5 w-5 text-vault-emerald" />;
  }

  return (
    <div
      className="flex-1 min-w-0 flex flex-col min-h-dvh lg:h-dvh lg:overflow-hidden bg-vault-canvas"
      onDragOver={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        setDragActive(false);
        const file = e.dataTransfer.files?.[0];
        handleSelectFile(file);
      }}
    >
      {/* Top Bar */}
      <header className="landscape-compact-header px-4 py-3 sm:px-6 sm:py-4 border-b border-vault-stone/16 bg-vault-canvas flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex items-start justify-between gap-3 min-w-0">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg sm:text-xl font-semibold text-vault-ivory tracking-tight truncate">
                {tab.meta.title}
              </h1>
              <span className="inline-flex items-center gap-1 rounded-full bg-vault-emerald/14 border border-vault-emerald/35 px-2 py-0.5 text-[11px] font-medium text-vault-emerald tabular-nums">
                <Lock className="h-3 w-3" />
                AES-256 · v{tab.keyVersion}
              </span>
              {tab.role === 'viewer' && (
                <span className="rounded-full border border-vault-stone/20 bg-vault-surface px-2 py-0.5 text-[11px] text-vault-muted">
                  Leitura
                </span>
              )}
            </div>
            {tab.meta.description && (
              <p className="text-xs text-vault-muted mt-0.5 truncate">{tab.meta.description}</p>
            )}
          </div>

          {/* Right-side collapsible drawer toggle on mobile/landscape (< lg) */}
          <button
            type="button"
            onClick={onOpenMobileMenu}
            aria-label="Abrir abas do cofre"
            className="lg:hidden shrink-0 inline-flex items-center gap-1.5 rounded-xl border border-vault-stone/25 bg-vault-surface px-3 py-2 text-xs font-medium text-vault-ivory hover:bg-vault-hover transition cursor-pointer"
          >
            <span className="hidden xs:inline sm:inline">Abas</span>
            <PanelRightOpen className="h-4 w-4 text-vault-stone" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canEdit && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  handleSelectFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-vault-ivory px-3 sm:px-3.5 py-2 text-xs font-semibold text-vault-canvas hover:bg-vault-stone transition cursor-pointer"
              >
                <Upload className="h-4 w-4" />
                <span>Enviar Arquivo</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  setNoteModal({ id: null, title: '', content: '', tags: '' })
                }
                className="inline-flex items-center gap-1.5 rounded-xl border border-vault-stone/25 bg-vault-surface px-3 sm:px-3.5 py-2 text-xs font-medium text-vault-ivory hover:bg-vault-hover transition cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                <span>Nova Nota</span>
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onOpenShare}
            className="inline-flex items-center gap-1.5 rounded-xl border border-vault-stone/22 bg-vault-surface px-3 py-2 text-xs font-medium text-vault-stone hover:bg-vault-hover transition cursor-pointer tabular-nums"
          >
            <Share2 className="h-4 w-4" />
            <span>Acesso ({tab.memberCount})</span>
          </button>
          {isOwner && (
            <button
              type="button"
              onClick={onDeleteTab}
              title="Excluir aba"
              className="rounded-xl border border-vault-stone/18 bg-vault-surface p-2 text-vault-muted hover:border-vault-danger/45 hover:bg-vault-danger/10 hover:text-vault-danger transition cursor-pointer"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      {/* Search & Filters */}
      <div className="landscape-compact-bar px-4 py-2.5 sm:px-6 sm:py-3 border-b border-vault-stone/14 bg-vault-deep/45 flex flex-wrap items-center gap-2.5">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="h-4 w-4 text-vault-muted absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar localmente por nome, tag ou nota..."
            className="w-full rounded-xl border border-vault-stone/20 bg-vault-deep pl-9 pr-3 py-2 text-xs text-vault-ivory placeholder-vault-muted/75 focus:border-vault-stone/50 focus:outline-none"
          />
        </div>
        <div className="inline-flex rounded-xl border border-vault-stone/20 bg-vault-deep p-0.5 text-xs">
          {(['all', 'file', 'note'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKindFilter(k)}
              className={`rounded-lg px-2.5 sm:px-3 py-1.5 font-medium transition cursor-pointer ${
                kindFilter === k
                  ? 'bg-vault-surface text-vault-ivory'
                  : 'text-vault-muted hover:text-vault-ivory'
              }`}
            >
              {k === 'all' ? 'Todos' : k === 'file' ? 'Arquivos' : 'Notas'}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content */}
      <div className="landscape-compact-content flex-1 lg:overflow-y-auto p-4 sm:p-6 relative">
        {dragActive && canEdit && (
          <div className="absolute inset-4 z-20 rounded-2xl border-2 border-dashed border-vault-emerald bg-vault-deep/90 backdrop-blur-xs flex flex-col items-center justify-center text-vault-ivory pointer-events-none">
            <Upload className="h-10 w-10 text-vault-emerald mb-2" />
            <div className="text-base font-semibold">Solte o arquivo para criptografar</div>
            <div className="text-xs text-vault-muted mt-1">
              Criptografia AES-256-GCM executada antes do envio ao servidor
            </div>
          </div>
        )}

        {loading ? (
          <div className="py-16 text-center text-sm text-vault-muted">
            Descriptografando itens localmente...
          </div>
        ) : filteredDocs.length === 0 ? (
          <div className="my-6 sm:my-10 mx-auto max-w-md rounded-2xl border border-dashed border-vault-stone/22 bg-vault-surface/50 p-8 sm:p-10 text-center">
            <Lock className="h-9 w-9 text-vault-muted/70 mx-auto mb-3" />
            <h3 className="text-sm font-semibold text-vault-ivory">
              {docs.length === 0 ? 'Cofre vazio nesta aba' : 'Nenhum resultado encontrado'}
            </h3>
            <p className="text-xs text-vault-muted mt-1.5 leading-relaxed">
              {docs.length === 0
                ? 'Envie arquivos (PDFs, imagens, comprovantes) ou crie notas pessoais. Tudo é criptografado no navegador antes de tocar o servidor.'
                : 'Tente outro termo de busca ou filtro.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
            {filteredDocs.map((doc) => (
              <div
                key={doc.id}
                className="group rounded-2xl border border-vault-stone/16 bg-vault-surface p-4 hover:border-vault-stone/32 transition flex flex-col justify-between gap-3"
              >
                <div>
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-vault-deep border border-vault-stone/18">
                      {renderIcon(doc)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3
                        className="text-sm font-semibold text-vault-ivory truncate"
                        title={doc.meta.name}
                      >
                        {doc.meta.name}
                      </h3>
                      <div className="text-[11px] text-vault-muted mt-0.5 tabular-nums">
                        {doc.kind === 'file'
                          ? `${formatBytes(doc.meta.originalSize ?? doc.blobSize)} · Arquivo .enc`
                          : 'Nota criptografada'}
                      </div>
                    </div>
                  </div>

                  {doc.kind === 'note' && doc.content && (
                    <p className="mt-3 text-xs text-vault-body line-clamp-3 whitespace-pre-wrap bg-vault-deep/75 rounded-xl p-2.5 border border-vault-stone/14">
                      {doc.content}
                    </p>
                  )}

                  {doc.kind === 'file' && doc.meta.summary && (
                    <p className="mt-2.5 text-xs text-vault-muted line-clamp-2">
                      {doc.meta.summary}
                    </p>
                  )}

                  {doc.meta.tags.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {doc.meta.tags.map((t) => (
                        <span
                          key={t}
                          className="inline-flex items-center gap-1 rounded-md border border-vault-stone/18 bg-vault-canvas px-2 py-0.5 text-[10px] text-vault-stone"
                        >
                          <Tag className="h-2.5 w-2.5 text-vault-emerald" />
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="pt-3 border-t border-vault-stone/14 flex items-center justify-between">
                  <span className="text-[11px] text-vault-muted tabular-nums">
                    {formatDateTime(doc.updatedAt)}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handlePreviewFile(doc)}
                      title={doc.kind === 'note' ? 'Abrir / Editar nota' : 'Visualizar localmente'}
                      className="rounded-lg p-2 sm:p-1.5 text-vault-muted hover:bg-vault-hover hover:text-vault-ivory transition cursor-pointer"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                    {doc.kind === 'file' && (
                      <button
                        type="button"
                        onClick={() => handleDownloadFile(doc)}
                        title="Descriptografar e baixar"
                        className="rounded-lg p-2 sm:p-1.5 text-vault-muted hover:bg-vault-hover hover:text-vault-emerald transition cursor-pointer"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => handleDeleteDoc(doc)}
                        title="Excluir"
                        className="rounded-lg p-2 sm:p-1.5 text-vault-muted hover:bg-vault-danger/12 hover:text-vault-danger transition cursor-pointer"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Upload Confirmation Modal */}
      {pendingFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-vault-deep/80 backdrop-blur-xs p-3 sm:p-4">
          <div className="w-full max-w-md max-h-[92dvh] overflow-y-auto rounded-2xl border border-vault-stone/30 bg-vault-surface p-5 sm:p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-vault-ivory">
                Criptografar e Enviar Arquivo
              </h2>
              <button
                type="button"
                onClick={() => setPendingFile(null)}
                className="rounded-lg p-1 text-vault-muted hover:bg-vault-hover hover:text-vault-ivory cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="rounded-xl border border-vault-stone/18 bg-vault-deep p-3 mb-4 text-xs">
              <div className="font-semibold text-vault-ivory truncate">{pendingFile.name}</div>
              <div className="text-vault-muted mt-0.5 tabular-nums">
                {formatBytes(pendingFile.size)} · {pendingFile.type || 'binário'}
              </div>
            </div>

            <form onSubmit={handleConfirmUpload} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-vault-stone mb-1">
                  Tags (separadas por vírgula)
                </label>
                <input
                  type="text"
                  value={fileTags}
                  onChange={(e) => setFileTags(e.target.value)}
                  placeholder="ex: IRPF, 2026, comprovante"
                  className="w-full rounded-xl border border-vault-stone/22 bg-vault-deep px-3 py-2 text-xs text-vault-ivory placeholder-vault-muted/70 focus:border-vault-stone/60 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-vault-stone mb-1">
                  Observação (opcional)
                </label>
                <input
                  type="text"
                  value={fileSummary}
                  onChange={(e) => setFileSummary(e.target.value)}
                  placeholder="Anotação criptografada sobre este documento"
                  className="w-full rounded-xl border border-vault-stone/22 bg-vault-deep px-3 py-2 text-xs text-vault-ivory placeholder-vault-muted/70 focus:border-vault-stone/60 focus:outline-none"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setPendingFile(null)}
                  className="rounded-xl border border-vault-stone/25 px-3.5 py-2 text-xs text-vault-stone hover:bg-vault-hover cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={uploading}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-vault-ivory px-4 py-2 text-xs font-semibold text-vault-canvas hover:bg-vault-stone disabled:opacity-50 cursor-pointer"
                >
                  <Lock className="h-3.5 w-3.5" />
                  {uploading ? 'Criptografando e enviando...' : 'Criptografar e Salvar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Note Create/Edit Modal */}
      {noteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-vault-deep/80 backdrop-blur-xs p-3 sm:p-4">
          <div className="w-full max-w-2xl max-h-[92dvh] overflow-y-auto rounded-2xl border border-vault-stone/30 bg-vault-surface p-5 sm:p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-vault-ivory">
                {noteModal.id ? 'Nota Criptografada' : 'Nova Nota Criptografada'}
              </h2>
              <button
                type="button"
                onClick={() => setNoteModal(null)}
                className="rounded-lg p-1 text-vault-muted hover:bg-vault-hover hover:text-vault-ivory cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSaveNote} className="space-y-3.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-vault-stone mb-1">
                    Título
                  </label>
                  <input
                    type="text"
                    required
                    disabled={!canEdit}
                    value={noteModal.title}
                    onChange={(e) =>
                      setNoteModal({ ...noteModal, title: e.target.value })
                    }
                    placeholder="Título da anotação"
                    className="w-full rounded-xl border border-vault-stone/22 bg-vault-deep px-3.5 py-2 text-sm text-vault-ivory placeholder-vault-muted/70 focus:border-vault-stone/60 focus:outline-none disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-vault-stone mb-1">
                    Tags (separadas por vírgula)
                  </label>
                  <input
                    type="text"
                    disabled={!canEdit}
                    value={noteModal.tags}
                    onChange={(e) =>
                      setNoteModal({ ...noteModal, tags: e.target.value })
                    }
                    placeholder="ex: banco, senhas, pessoal"
                    className="w-full rounded-xl border border-vault-stone/22 bg-vault-deep px-3.5 py-2 text-xs text-vault-ivory placeholder-vault-muted/70 focus:border-vault-stone/60 focus:outline-none disabled:opacity-60"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-vault-stone mb-1">
                  Conteúdo
                </label>
                <textarea
                  rows={8}
                  disabled={!canEdit}
                  value={noteModal.content}
                  onChange={(e) =>
                    setNoteModal({ ...noteModal, content: e.target.value })
                  }
                  placeholder="Escreva aqui — todo este conteúdo será criptografado no navegador..."
                  className="w-full rounded-xl border border-vault-stone/22 bg-vault-deep p-3.5 text-sm text-vault-ivory placeholder-vault-muted/70 font-mono leading-relaxed focus:border-vault-stone/60 focus:outline-none disabled:opacity-60"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setNoteModal(null)}
                  className="rounded-xl border border-vault-stone/25 px-4 py-2 text-xs text-vault-stone hover:bg-vault-hover cursor-pointer"
                >
                  Fechar
                </button>
                {canEdit && (
                  <button
                    type="submit"
                    disabled={savingNote}
                    className="rounded-xl bg-vault-ivory px-4 py-2 text-xs font-semibold text-vault-canvas hover:bg-vault-stone disabled:opacity-50 cursor-pointer"
                  >
                    {savingNote ? 'Criptografando...' : 'Salvar Nota'}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Secure Local File Preview Modal */}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-vault-deep/85 backdrop-blur-xs p-2 sm:p-4">
          <div className="w-full max-w-4xl max-h-[94dvh] flex flex-col rounded-2xl border border-vault-stone/30 bg-vault-surface shadow-2xl overflow-hidden">
            <div className="px-4 sm:px-5 py-3 border-b border-vault-stone/16 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-vault-ivory truncate">
                  {preview.doc.meta.name}
                </div>
                <div className="text-[11px] text-vault-emerald truncate">
                  Descriptografado localmente na memória do navegador
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => handleDownloadFile(preview.doc)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-vault-stone/25 bg-vault-canvas px-3 py-1.5 text-xs text-vault-ivory hover:bg-vault-hover cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Baixar</span>
                </button>
                <button
                  type="button"
                  onClick={closePreview}
                  className="rounded-lg p-1.5 text-vault-muted hover:bg-vault-hover hover:text-vault-ivory cursor-pointer"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto bg-vault-deep p-3 sm:p-4 flex items-center justify-center min-h-[260px]">
              {preview.loading ? (
                <div className="text-sm text-vault-muted">
                  Baixando blob criptografado e descriptografando localmente...
                </div>
              ) : preview.textContent !== null ? (
                <pre className="w-full h-full overflow-auto text-xs text-vault-body font-mono whitespace-pre-wrap p-3">
                  {preview.textContent}
                </pre>
              ) : preview.url && (preview.doc.meta.mimeType ?? '').startsWith('image/') ? (
                <img
                  src={preview.url}
                  alt={preview.doc.meta.name}
                  className="max-h-[76dvh] max-w-full rounded-lg object-contain"
                />
              ) : preview.url && preview.doc.meta.mimeType === 'application/pdf' ? (
                <iframe
                  src={preview.url}
                  title={preview.doc.meta.name}
                  className="w-full h-[76dvh] rounded-lg border border-vault-stone/20 bg-white"
                />
              ) : (
                <div className="text-center space-y-3">
                  <File className="h-12 w-12 text-vault-muted mx-auto" />
                  <p className="text-sm text-vault-body">
                    Pré-visualização não disponível para este tipo de arquivo (
                    {preview.doc.meta.mimeType || 'binário'}).
                  </p>
                  <button
                    type="button"
                    onClick={() => handleDownloadFile(preview.doc)}
                    className="inline-flex items-center gap-2 rounded-xl bg-vault-ivory px-4 py-2 text-xs font-semibold text-vault-canvas hover:bg-vault-stone cursor-pointer"
                  >
                    <Download className="h-4 w-4" />
                    Baixar arquivo descriptografado
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
