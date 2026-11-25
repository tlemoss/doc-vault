import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Link2,
  Shield,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import type { AdminInvite, AdminUser, UserRole } from '../types';
import { formatBytes, formatDateTime } from '../utils/format';

interface AdminModalProps {
  currentUserId: string;
  defaultQuotaBytes: number;
  onClose: () => void;
  onRefreshCurrentUser: () => Promise<void>;
  onNotify: (msg: string, tone?: 'ok' | 'err') => void;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export function AdminModal({
  currentUserId,
  defaultQuotaBytes,
  onClose,
  onRefreshCurrentUser,
  onNotify,
}: AdminModalProps) {
  const [section, setSection] = useState<'users' | 'invites'>('users');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [loading, setLoading] = useState(true);

  // Invite form
  const [invUsername, setInvUsername] = useState('');
  const [invRole, setInvRole] = useState<UserRole>('user');
  const [invQuotaMb, setInvQuotaMb] = useState(Math.round(defaultQuotaBytes / MB));
  const [invExpiresHours, setInvExpiresHours] = useState(72);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  // Quota inline edits
  const [quotaEdits, setQuotaEdits] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ users: u }, { invites: inv }] = await Promise.all([
        api.users.adminList(),
        api.users.adminListInvites(),
      ]);
      setUsers(u);
      setInvites(inv);
      const map: Record<string, number> = {};
      for (const item of u) {
        map[item.id] = Math.round(item.quotaBytes / MB);
      }
      setQuotaEdits(map);
    } catch (err: unknown) {
      onNotify(
        err instanceof Error ? err.message : 'Erro ao carregar dados administrativos.',
        'err'
      );
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleUpdateUser(
    id: string,
    patch: { quotaBytes?: number; role?: UserRole; isActive?: boolean }
  ) {
    try {
      await api.users.adminUpdate(id, patch);
      await load();
      if (id === currentUserId) {
        await onRefreshCurrentUser();
      }
      onNotify('Usuário atualizado.');
    } catch (err: unknown) {
      onNotify(
        err instanceof Error ? err.message : 'Erro ao atualizar usuário.',
        'err'
      );
    }
  }

  async function handleCreateInvite(e: React.FormEvent) {
    e.preventDefault();
    try {
      const { invite } = await api.users.adminCreateInvite({
        username: invUsername.trim() || undefined,
        role: invRole,
        quotaBytes: Math.max(1, invQuotaMb) * MB,
        expiresInHours: invExpiresHours,
      });
      const link = `${window.location.origin}/?invite=${encodeURIComponent(invite.token)}`;
      setCreatedLink(link);
      setInvUsername('');
      await load();
      onNotify('Link de convite gerado! Copie e envie ao usuário.');
    } catch (err: unknown) {
      onNotify(
        err instanceof Error ? err.message : 'Erro ao criar convite.',
        'err'
      );
    }
  }

  async function handleRevokeInvite(tokenHash: string) {
    try {
      await api.users.adminDeleteInvite(tokenHash);
      setInvites((prev) => prev.filter((i) => i.tokenHash !== tokenHash));
      onNotify('Convite revogado.');
    } catch (err: unknown) {
      onNotify(
        err instanceof Error ? err.message : 'Erro ao revogar convite.',
        'err'
      );
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="w-full max-w-3xl rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <Shield className="h-5 w-5 text-emerald-400" />
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Administração da Plataforma
              </h2>
              <p className="text-xs text-slate-400">
                Gerencie contas, limites de armazenamento (padrão 1 GB) e convites Zero-Knowledge.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 border-b border-slate-800 pb-3 mb-4">
          <button
            type="button"
            onClick={() => setSection('users')}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition cursor-pointer ${
              section === 'users'
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                : 'text-slate-400 hover:bg-slate-800'
            }`}
          >
            <Users className="h-4 w-4" />
            Usuários ({users.length})
          </button>
          <button
            type="button"
            onClick={() => setSection('invites')}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition cursor-pointer ${
              section === 'invites'
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                : 'text-slate-400 hover:bg-slate-800'
            }`}
          >
            <UserPlus className="h-4 w-4" />
            Convites ({invites.filter((i) => !i.usedBy).length} pendentes)
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-4 pr-1">
          {loading ? (
            <div className="py-10 text-center text-xs text-slate-400">Carregando...</div>
          ) : section === 'users' ? (
            users.map((u) => {
              const pct = Math.min(
                100,
                u.quotaBytes > 0 ? Math.round((u.usedBytes / u.quotaBytes) * 100) : 0
              );
              return (
                <div
                  key={u.id}
                  className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-100">
                          {u.username}
                        </span>
                        {u.id === currentUserId && (
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                            você
                          </span>
                        )}
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            u.isActive
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : 'bg-rose-500/15 text-rose-300'
                          }`}
                        >
                          {u.isActive ? 'Ativo' : 'Desativado'}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Uso: {formatBytes(u.usedBytes)} / {formatBytes(u.quotaBytes)} ({pct}%) ·
                        Criado em {formatDateTime(u.createdAt)}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={u.role}
                        onChange={(e) =>
                          handleUpdateUser(u.id, { role: e.target.value as UserRole })
                        }
                        className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200"
                      >
                        <option value="user">Usuário</option>
                        <option value="admin">Administrador</option>
                      </select>

                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateUser(u.id, { isActive: !u.isActive })
                        }
                        className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium cursor-pointer ${
                          u.isActive
                            ? 'border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20'
                            : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                        }`}
                      >
                        {u.isActive ? 'Desativar' : 'Reativar'}
                      </button>
                    </div>
                  </div>

                  {/* Quota adjuster */}
                  <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800/80 text-xs">
                    <span className="text-slate-400">Quota (MB):</span>
                    <input
                      type="number"
                      min={1}
                      max={102400}
                      value={quotaEdits[u.id] ?? Math.round(u.quotaBytes / MB)}
                      onChange={(e) =>
                        setQuotaEdits((prev) => ({
                          ...prev,
                          [u.id]: Number(e.target.value),
                        }))
                      }
                      className="w-24 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 font-mono text-slate-100"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        handleUpdateUser(u.id, {
                          quotaBytes: Math.max(1, quotaEdits[u.id] ?? 1024) * MB,
                        })
                      }
                      className="rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1 text-slate-200 hover:bg-slate-700 cursor-pointer"
                    >
                      Aplicar
                    </button>
                    <div className="flex gap-1 ml-auto">
                      {[
                        { label: '500 MB', bytes: 500 * MB },
                        { label: '1 GB', bytes: 1 * GB },
                        { label: '5 GB', bytes: 5 * GB },
                      ].map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() =>
                            handleUpdateUser(u.id, { quotaBytes: preset.bytes })
                          }
                          className="rounded-md bg-slate-900 border border-slate-800 px-2 py-0.5 text-[11px] text-slate-400 hover:text-emerald-300 hover:border-emerald-500/40 cursor-pointer"
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <>
              <form
                onSubmit={handleCreateInvite}
                className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-3"
              >
                <div className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                  <Link2 className="h-4 w-4 text-emerald-400" />
                  Gerar Novo Link de Convite (Uso Único)
                </div>
                <p className="text-[11px] text-slate-400">
                  O usuário convidado abrirá o link e criará sua própria senha mestre e par de
                  chaves RSA localmente no navegador.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Usuário reservado (opcional)
                    </label>
                    <input
                      type="text"
                      value={invUsername}
                      onChange={(e) => setInvUsername(e.target.value)}
                      placeholder="Livre se vazio"
                      className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Perfil</label>
                    <select
                      value={invRole}
                      onChange={(e) => setInvRole(e.target.value as UserRole)}
                      className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-100"
                    >
                      <option value="user">Usuário</option>
                      <option value="admin">Administrador</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Quota inicial (MB — 1024 = 1 GB)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={102400}
                      value={invQuotaMb}
                      onChange={(e) => setInvQuotaMb(Number(e.target.value))}
                      className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-mono text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Validade (horas)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={720}
                      value={invExpiresHours}
                      onChange={(e) => setInvExpiresHours(Number(e.target.value))}
                      className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-mono text-slate-100"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
                >
                  Gerar Link de Convite
                </button>

                {createdLink && (
                  <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 space-y-2">
                    <div className="text-[11px] font-semibold text-emerald-300">
                      Link de convite pronto (exibido uma única vez):
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        readOnly
                        value={createdLink}
                        className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-[11px] text-emerald-200"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          await navigator.clipboard.writeText(createdLink);
                          setCopiedLink(true);
                          setTimeout(() => setCopiedLink(false), 2000);
                        }}
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
                      >
                        {copiedLink ? (
                          <>
                            <Check className="h-3.5 w-3.5" />
                            Copiado
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            Copiar
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </form>

              <div className="space-y-2">
                <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                  Histórico de convites
                </div>
                {invites.length === 0 ? (
                  <p className="text-xs text-slate-500">Nenhum convite criado ainda.</p>
                ) : (
                  invites.map((inv) => {
                    const expired = new Date(inv.expiresAt).getTime() <= Date.now();
                    return (
                      <div
                        key={inv.tokenHash}
                        className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 px-3.5 py-2.5 text-xs"
                      >
                        <div>
                          <div className="font-medium text-slate-200">
                            {inv.username ? `Reservado: ${inv.username}` : 'Qualquer usuário'} ·{' '}
                            <span className="text-slate-400">{formatBytes(inv.quotaBytes)}</span>
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {inv.usedBy
                              ? `Usado por ${inv.usedBy}`
                              : expired
                                ? 'Expirado'
                                : `Expira em ${formatDateTime(inv.expiresAt)}`}
                          </div>
                        </div>
                        {!inv.usedBy && (
                          <button
                            type="button"
                            onClick={() => handleRevokeInvite(inv.tokenHash)}
                            title="Revogar convite"
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/10 hover:text-rose-400 cursor-pointer"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
