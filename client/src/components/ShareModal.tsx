import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  KeyRound,
  RefreshCw,
  Shield,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import { wrapTabKeyForPublicKey } from '../crypto/engine';
import { rotateTabKey } from '../crypto/vault';
import type { DecryptedTab, DirectoryUser, TabMember, TabRole } from '../types';

interface ShareModalProps {
  tab: DecryptedTab;
  currentUserId: string;
  onClose: () => void;
  onUpdated: (newTabKey?: CryptoKey, memberCount?: number) => void;
  onNotify: (msg: string, tone?: 'ok' | 'err') => void;
}

const ROLE_LABELS: Record<TabRole, string> = {
  owner: 'Proprietário',
  editor: 'Editor',
  viewer: 'Leitor',
};

export function ShareModal({
  tab,
  currentUserId,
  onClose,
  onUpdated,
  onNotify,
}: ShareModalProps) {
  const isOwner = tab.role === 'owner';
  const [members, setMembers] = useState<TabMember[]>([]);
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedRole, setSelectedRole] = useState<TabRole>('viewer');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [suggestRotate, setSuggestRotate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ members: m }, { users: dir }] = await Promise.all([
        api.tabs.listAccess(tab.id),
        api.users.directory(),
      ]);
      setMembers(m);
      setDirectory(dir);
    } catch (err: unknown) {
      onNotify(
        err instanceof Error ? err.message : 'Erro ao carregar permissões.',
        'err'
      );
    } finally {
      setLoading(false);
    }
  }, [tab.id, onNotify]);

  useEffect(() => {
    void load();
  }, [load]);

  const memberIds = new Set(members.map((m) => m.userId));
  const availableUsers = directory.filter((u) => !memberIds.has(u.id));

  async function handleGrant(e: React.FormEvent) {
    e.preventDefault();
    const target = directory.find((u) => u.id === selectedUserId);
    if (!target) return;
    setBusy(true);
    try {
      const wrappedTabKey = await wrapTabKeyForPublicKey(
        tab.tabKey,
        target.publicKey
      );
      await api.tabs.grantAccess(tab.id, {
        userId: target.id,
        role: selectedRole,
        wrappedTabKey,
      });
      await load();
      setSelectedUserId('');
      onUpdated(undefined, members.length + 1);
      onNotify(
        `Acesso concedido para ${target.username} (chave empacotada com RSA-OAEP).`
      );
    } catch (err: unknown) {
      onNotify(
        err instanceof Error ? err.message : 'Erro ao compartilhar aba.',
        'err'
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleChangeRole(member: TabMember, nextRole: TabRole) {
    setBusy(true);
    try {
      const wrappedTabKey = await wrapTabKeyForPublicKey(
        tab.tabKey,
        member.publicKey
      );
      await api.tabs.grantAccess(tab.id, {
        userId: member.userId,
        role: nextRole,
        wrappedTabKey,
      });
      setMembers((prev) =>
        prev.map((m) =>
          m.userId === member.userId ? { ...m, role: nextRole } : m
        )
      );
      onNotify(`Permissão de ${member.username} atualizada para ${ROLE_LABELS[nextRole]}.`);
    } catch (err: unknown) {
      onNotify(
        err instanceof Error ? err.message : 'Erro ao alterar permissão.',
        'err'
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(member: TabMember) {
    if (
      !window.confirm(
        `Revogar acesso de "${member.username}" à aba "${tab.meta.title}"?`
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.tabs.revokeAccess(tab.id, member.userId);
      const nextCount = members.length - 1;
      setMembers((prev) => prev.filter((m) => m.userId !== member.userId));
      setSuggestRotate(true);
      onUpdated(undefined, nextCount);
      onNotify(`Acesso de ${member.username} revogado.`);
    } catch (err: unknown) {
      onNotify(
        err instanceof Error ? err.message : 'Erro ao revogar acesso.',
        'err'
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleRotateKey() {
    setRotating(true);
    try {
      const newKey = await rotateTabKey(tab);
      setSuggestRotate(false);
      onUpdated(newKey, members.length);
      onNotify(
        'Chave criptográfica da aba rotacionada! Usuários revogados não conseguem mais decifrar nada.'
      );
    } catch (err: unknown) {
      onNotify(
        err instanceof Error ? err.message : 'Erro ao rotacionar chave da aba.',
        'err'
      );
    } finally {
      setRotating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-vault-deep/80 backdrop-blur-xs p-4">
      <div className="w-full max-w-xl rounded-2xl border border-vault-stone/30 bg-vault-surface p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <Shield className="h-5 w-5 text-vault-emerald" />
            <div>
              <h2 className="text-base font-semibold text-vault-ivory">
                Controle de Acesso — {tab.meta.title}
              </h2>
              <p className="text-xs text-vault-muted">
                Chave AES-256-GCM (versão v{tab.keyVersion}) compartilhada via RSA-OAEP
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-vault-muted hover:bg-vault-hover hover:text-vault-ivory cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {suggestRotate && isOwner && (
          <div className="mb-4 rounded-xl border border-vault-warning/40 bg-vault-warning/10 p-3.5 text-xs text-vault-ivory space-y-2">
            <div className="flex items-center gap-2 font-semibold text-vault-warning">
              <AlertTriangle className="h-4 w-4" />
              Recomendado: Rotacionar a chave criptográfica da aba
            </div>
            <p className="text-vault-body">
              Para garantir sigilo futuro absoluto após revogar um usuário, gere uma nova chave
              AES-256 e re-empacote automaticamente os dados desta aba para os membros restantes.
            </p>
            <button
              type="button"
              disabled={rotating}
              onClick={handleRotateKey}
              className="inline-flex items-center gap-1.5 rounded-lg bg-vault-warning px-3 py-1.5 text-xs font-semibold text-vault-deep hover:opacity-90 cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${rotating ? 'animate-spin' : ''}`} />
              {rotating ? 'Rotacionando chave...' : 'Rotacionar Chave Agora'}
            </button>
          </div>
        )}

        {isOwner && (
          <form
            onSubmit={handleGrant}
            className="mb-5 rounded-xl border border-vault-stone/18 bg-vault-deep/80 p-3.5 space-y-3"
          >
            <div className="text-xs font-medium text-vault-stone flex items-center gap-1.5">
              <UserPlus className="h-3.5 w-3.5 text-vault-emerald" />
              Conceder acesso a outro usuário
            </div>

            {availableUsers.length === 0 ? (
              <p className="text-xs text-vault-muted">
                Todos os usuários ativos já possuem acesso (ou crie novos usuários via convite no
                painel de Administração).
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <select
                  value={selectedUserId}
                  onChange={(e) => setSelectedUserId(e.target.value)}
                  required
                  className="flex-1 min-w-[160px] rounded-xl border border-vault-stone/22 bg-vault-canvas px-3 py-2 text-xs text-vault-ivory focus:border-vault-stone/60 focus:outline-none"
                >
                  <option value="">Selecione um usuário...</option>
                  {availableUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.username} ({u.publicKeyFingerprint.slice(0, 14)}...)
                    </option>
                  ))}
                </select>
                <select
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value as TabRole)}
                  className="rounded-xl border border-vault-stone/22 bg-vault-canvas px-3 py-2 text-xs text-vault-ivory"
                >
                  <option value="viewer">Leitor</option>
                  <option value="editor">Editor</option>
                  <option value="owner">Proprietário</option>
                </select>
                <button
                  type="submit"
                  disabled={busy || !selectedUserId}
                  className="rounded-xl bg-vault-ivory px-4 py-2 text-xs font-semibold text-vault-canvas hover:bg-vault-stone disabled:opacity-50 cursor-pointer"
                >
                  Compartilhar
                </button>
              </div>
            )}
          </form>
        )}

        <div className="space-y-2 mb-5">
          <div className="text-[10px] font-semibold text-vault-muted uppercase tracking-[0.14em]">
            Usuários com acesso ({members.length})
          </div>

          {loading ? (
            <div className="py-6 text-center text-xs text-vault-muted">Carregando...</div>
          ) : (
            members.map((m) => (
              <div
                key={m.userId}
                className="flex items-center justify-between gap-3 rounded-xl border border-vault-stone/16 bg-vault-deep/60 px-3.5 py-2.5"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-vault-ivory flex items-center gap-2">
                    {m.username}
                    {m.userId === currentUserId && (
                      <span className="rounded bg-vault-stone/12 px-1.5 py-0.5 text-[10px] text-vault-stone">
                        você
                      </span>
                    )}
                  </div>
                  <div
                    className="text-[10px] font-mono text-vault-muted truncate"
                    title={`Fingerprint da chave pública: ${m.publicKeyFingerprint}`}
                  >
                    Chave: {m.publicKeyFingerprint}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isOwner ? (
                    <>
                      <select
                        disabled={busy}
                        value={m.role}
                        onChange={(e) =>
                          handleChangeRole(m, e.target.value as TabRole)
                        }
                        className="rounded-lg border border-vault-stone/22 bg-vault-canvas px-2.5 py-1 text-xs text-vault-ivory"
                      >
                        <option value="viewer">Leitor</option>
                        <option value="editor">Editor</option>
                        <option value="owner">Proprietário</option>
                      </select>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleRevoke(m)}
                        title="Revogar acesso"
                        className="rounded-lg p-1.5 text-vault-muted hover:bg-vault-danger/12 hover:text-vault-danger cursor-pointer"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  ) : (
                    <span className="rounded-lg border border-vault-stone/18 bg-vault-canvas px-2.5 py-1 text-xs text-vault-stone">
                      {ROLE_LABELS[m.role]}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {isOwner && (
          <div className="pt-4 border-t border-vault-stone/14 flex items-center justify-between gap-3">
            <div className="text-[11px] text-vault-muted flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5 text-vault-emerald shrink-0" />
              <span>Re-criptografa metadados, notas, linhas e chaves de arquivo sob nova Tab Key.</span>
            </div>
            <button
              type="button"
              disabled={rotating}
              onClick={handleRotateKey}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-xl border border-vault-stone/25 bg-vault-canvas px-3 py-1.5 text-xs font-medium text-vault-stone hover:bg-vault-hover disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${rotating ? 'animate-spin' : ''}`} />
              {rotating ? 'Rotacionando...' : 'Rotacionar Chave'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
