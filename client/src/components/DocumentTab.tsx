import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  Eye,
  File,
  FileImage,
  FileText,
  Lock,
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
  onNotify: (msg: string, tone?: 'ok' | 'err') => void;
}

export function DocumentTab({
  tab,
  maxFileSizeBytes,
  onQuotaChanged,
  onOpenShare,
  onDeleteTab,
  onNotify,
}: DocumentTabProps) {
  const canEdit = tab.role === 'owner' || tab.role === 'editor';
  const isOwner = tab.role === 'owner';

  const [docs, setDocs] = useState<DecryptedDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'file' | 'note'>('all');
  const [dragActive, setDragActive] = useState(false);

  // Upload modal state
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [fileTags, setFileTags] = useState('');
  const [fileSummary, setFileSummary] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Note modal state (create or edit)
  const [noteModal, setNoteModal] = useState<{
    id: string | null;
    title: string;
    content: string;
    tags: string;
  } | null>(null);
  const [savingNote, setSavingNote] = useState(false);

  // Secure preview modal state
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

  // Revoke any active object URL when preview closes or unmounts
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
      return <StickyNote className="h-5 w-5 text-amber-400" />;
    }
    const mime = doc.meta.mimeType ?? '';
    if (mime.startsWith('image/')) {
      return <FileImage className="h-5 w-5 text-sky-400" />;
    }
    if (mime === 'application/pdf') {
      return <FileText className="h-5 w-5 text-rose-400" />;
    }
    return <File className="h-5 w-5 text-emerald-400" />;
  }

  return (
    <div
      className="flex-1 flex flex-col h-screen overflow-hidden"
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
      <header className="px-6 py-4 border-b border-slate-800 bg-slate-900/50 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-slate-100 truncate">{tab.meta.title}</h1>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
              <Lock className="h-3 w-3" />
              AES-256 · v{tab.keyVersion}
            </span>
            {tab.role === 'viewer' && (
              <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">
                Somente leitura
              </span>
            )}
          </div>
          {tab.meta.description && (
            <p className="text-xs text-slate-400 mt-0.5 truncate">{tab.meta.description}</p>
          )}
        </div>

        <div className="flex items-center gap-2">
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
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 transition cursor-pointer"
              >
                <Upload className="h-4 w-4" />
                Enviar Arquivo
              </button>
              <button
                type="button"
                onClick={() =>
                  setNoteModal({ id: null, title: '', content: '', tags: '' })
                }
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-100 hover:bg-slate-700 transition cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                Nova Nota
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onOpenShare}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 transition cursor-pointer"
          >
            <Share2 className="h-4 w-4" />
            Acesso ({tab.memberCount})
          </button>
          {isOwner && (
            <button
              type="button"
              onClick={onDeleteTab}
              title="Excluir aba"
              className="rounded-xl border border-slate-800 p-2 text-slate-400 hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-400 transition cursor-pointer"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      {/* Search & Filters */}
      <div className="px-6 py-3 border-b border-slate-800/70 bg-slate-950/40 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="h-4 w-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar localmente por nome, tag ou conteúdo de nota..."
            className="w-full rounded-xl border border-slate-800 bg-slate-900 pl-9 pr-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
          />
        </div>
        <div className="inline-flex rounded-xl border border-slate-800 bg-slate-900 p-0.5 text-xs">
          {(['all', 'file', 'note'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKindFilter(k)}
              className={`rounded-lg px-3 py-1.5 font-medium transition cursor-pointer ${
                kindFilter === k
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {k === 'all' ? 'Todos' : k === 'file' ? 'Arquivos' : 'Notas'}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-6 relative">
        {dragActive && canEdit && (
          <div className="absolute inset-4 z-20 rounded-2xl border-2 border-dashed border-emerald-500 bg-emerald-950/60 backdrop-blur-xs flex flex-col items-center justify-center text-emerald-200 pointer-events-none">
            <Upload className="h-10 w-10 mb-2" />
            <div className="text-base font-semibold">Solte o arquivo para criptografar</div>
            <div className="text-xs text-emerald-300/80 mt-1">
              Criptografia AES-256-GCM executada antes do envio ao servidor
            </div>
          </div>
        )}

        {loading ? (
          <div className="py-16 text-center text-sm text-slate-400">
            Descriptografando itens localmente...
          </div>
        ) : filteredDocs.length === 0 ? (
          <div className="my-10 mx-auto max-w-md rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-10 text-center">
            <Lock className="h-9 w-9 text-slate-600 mx-auto mb-3" />
            <h3 className="text-sm font-semibold text-slate-200">
              {docs.length === 0 ? 'Cofre vazio nesta aba' : 'Nenhum resultado encontrado'}
            </h3>
            <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
              {docs.length === 0
                ? 'Arraste arquivos aqui (PDFs, imagens, comprovantes) ou crie notas pessoais. Tudo é criptografado no navegador antes de tocar o servidor.'
                : 'Tente outro termo de busca ou filtro.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredDocs.map((doc) => (
              <div
                key={doc.id}
                className="group rounded-2xl border border-slate-800 bg-slate-900/70 p-4 hover:border-slate-700 transition flex flex-col justify-between gap-3"
              >
                <div>
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-800/80 border border-slate-700/60">
                      {renderIcon(doc)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3
                        className="text-sm font-semibold text-slate-100 truncate"
                        title={doc.meta.name}
                      >
                        {doc.meta.name}
                      </h3>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {doc.kind === 'file'
                          ? `${formatBytes(doc.meta.originalSize ?? doc.blobSize)} · Arquivo .enc`
                          : 'Nota criptografada'}
                      </div>
                    </div>
                  </div>

                  {doc.kind === 'note' && doc.content && (
                    <p className="mt-3 text-xs text-slate-300 line-clamp-3 whitespace-pre-wrap bg-slate-950/50 rounded-xl p-2.5 border border-slate-800/80">
                      {doc.content}
                    </p>
                  )}

                  {doc.kind === 'file' && doc.meta.summary && (
                    <p className="mt-2.5 text-xs text-slate-400 line-clamp-2">
                      {doc.meta.summary}
                    </p>
                  )}

                  {doc.meta.tags.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {doc.meta.tags.map((t) => (
                        <span
                          key={t}
                          className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300"
                        >
                          <Tag className="h-2.5 w-2.5 text-emerald-400" />
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between">
                  <span className="text-[11px] text-slate-500">
                    {formatDateTime(doc.updatedAt)}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handlePreviewFile(doc)}
                      title={doc.kind === 'note' ? 'Abrir / Editar nota' : 'Visualizar localmente'}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-emerald-400 transition cursor-pointer"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                    {doc.kind === 'file' && (
                      <button
                        type="button"
                        onClick={() => handleDownloadFile(doc)}
                        title="Descriptografar e baixar"
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-sky-400 transition cursor-pointer"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => handleDeleteDoc(doc)}
                        title="Excluir"
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-rose-400 transition cursor-pointer"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-slate-100">
                Criptografar e Enviar Arquivo
              </h2>
              <button
                type="button"
                onClick={() => setPendingFile(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3 mb-4 text-xs">
              <div className="font-semibold text-slate-100 truncate">{pendingFile.name}</div>
              <div className="text-slate-400 mt-0.5">
                {formatBytes(pendingFile.size)} · {pendingFile.type || 'binário'}
              </div>
            </div>

            <form onSubmit={handleConfirmUpload} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Tags (separadas por vírgula)
                </label>
                <input
                  type="text"
                  value={fileTags}
                  onChange={(e) => setFileTags(e.target.value)}
                  placeholder="ex: IRPF, 2026, comprovante"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Observação (opcional)
                </label>
                <input
                  type="text"
                  value={fileSummary}
                  onChange={(e) => setFileSummary(e.target.value)}
                  placeholder="Anotação criptografada sobre este documento"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setPendingFile(null)}
                  className="rounded-xl border border-slate-700 px-3.5 py-2 text-xs text-slate-300 hover:bg-slate-800 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={uploading}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 cursor-pointer"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-slate-100">
                {noteModal.id ? 'Nota Criptografada' : 'Nova Nota Criptografada'}
              </h2>
              <button
                type="button"
                onClick={() => setNoteModal(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSaveNote} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
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
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none disabled:opacity-60"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
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
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none disabled:opacity-60"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Conteúdo
                </label>
                <textarea
                  rows={10}
                  disabled={!canEdit}
                  value={noteModal.content}
                  onChange={(e) =>
                    setNoteModal({ ...noteModal, content: e.target.value })
                  }
                  placeholder="Escreva aqui — todo este conteúdo será criptografado no navegador..."
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 p-3.5 text-sm text-slate-100 font-mono leading-relaxed focus:border-emerald-500 focus:outline-none disabled:opacity-60"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setNoteModal(null)}
                  className="rounded-xl border border-slate-700 px-4 py-2 text-xs text-slate-300 hover:bg-slate-800 cursor-pointer"
                >
                  Fechar
                </button>
                {canEdit && (
                  <button
                    type="submit"
                    disabled={savingNote}
                    className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 cursor-pointer"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4">
          <div className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-100 truncate">
                  {preview.doc.meta.name}
                </div>
                <div className="text-[11px] text-emerald-400">
                  Descriptografado exclusivamente na memória do seu navegador
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleDownloadFile(preview.doc)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" />
                  Baixar
                </button>
                <button
                  type="button"
                  onClick={closePreview}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto bg-slate-950 p-4 flex items-center justify-center min-h-[400px]">
              {preview.loading ? (
                <div className="text-sm text-slate-400">
                  Baixando blob criptografado e descriptografando localmente...
                </div>
              ) : preview.textContent !== null ? (
                <pre className="w-full h-full overflow-auto text-xs text-slate-200 font-mono whitespace-pre-wrap p-3">
                  {preview.textContent}
                </pre>
              ) : preview.url && (preview.doc.meta.mimeType ?? '').startsWith('image/') ? (
                <img
                  src={preview.url}
                  alt={preview.doc.meta.name}
                  className="max-h-[75vh] max-w-full rounded-lg object-contain"
                />
              ) : preview.url && preview.doc.meta.mimeType === 'application/pdf' ? (
                <iframe
                  src={preview.url}
                  title={preview.doc.meta.name}
                  className="w-full h-[75vh] rounded-lg border border-slate-800 bg-white"
                />
              ) : (
                <div className="text-center space-y-3">
                  <File className="h-12 w-12 text-slate-500 mx-auto" />
                  <p className="text-sm text-slate-300">
                    Pré-visualização não disponível para este tipo de arquivo (
                    {preview.doc.meta.mimeType || 'binário'}).
                  </p>
                  <button
                    type="button"
                    onClick={() => handleDownloadFile(preview.doc)}
                    className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
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
