import {
  FileText,
  FolderLock,
  Lock,
  LogOut,
  Plus,
  Settings,
  ShieldCheck,
  Table2,
  Users,
} from 'lucide-react';
import type { CurrentUser, DecryptedTab } from '../types';
import { formatBytes } from '../utils/format';

interface SidebarProps {
  user: CurrentUser;
  tabs: DecryptedTab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onOpenCreateTab: () => void;
  onOpenAdmin: () => void;
  onLockVault: () => void;
  onLogout: () => void;
}

export function Sidebar({
  user,
  tabs,
  activeTabId,
  onSelectTab,
  onOpenCreateTab,
  onOpenAdmin,
  onLockVault,
  onLogout,
}: SidebarProps) {
  const docTabs = tabs.filter((t) => t.type === 'documents');
  const tableTabs = tabs.filter((t) => t.type === 'table');
  const usagePct = Math.min(
    100,
    user.quotaBytes > 0 ? Math.round((user.usedBytes / user.quotaBytes) * 100) : 0
  );

  function renderTabButton(tab: DecryptedTab) {
    const active = tab.id === activeTabId;
    return (
      <button
        key={tab.id}
        type="button"
        onClick={() => onSelectTab(tab.id)}
        className={`w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition cursor-pointer ${
          active
            ? 'bg-vault-emerald/14 text-vault-ivory border border-vault-emerald/35'
            : 'text-vault-body hover:bg-vault-surface border border-transparent'
        }`}
      >
        {tab.type === 'documents' ? (
          <FileText
            className={`h-4 w-4 shrink-0 ${active ? 'text-vault-emerald' : 'text-vault-muted'}`}
          />
        ) : (
          <Table2
            className={`h-4 w-4 shrink-0 ${active ? 'text-vault-emerald' : 'text-vault-muted'}`}
          />
        )}
        <span className="truncate flex-1 font-medium">{tab.meta.title}</span>
        {tab.memberCount > 1 && (
          <span
            title={`Compartilhada com ${tab.memberCount} pessoas`}
            className="inline-flex items-center gap-0.5 rounded-md bg-vault-stone/12 px-1.5 py-0.5 text-[10px] text-vault-stone tabular-nums"
          >
            <Users className="h-2.5 w-2.5" />
            {tab.memberCount}
          </span>
        )}
      </button>
    );
  }

  return (
    <aside className="w-72 shrink-0 border-r border-vault-stone/16 bg-vault-deep flex flex-col h-screen">
      {/* Header */}
      <div className="p-4 border-b border-vault-stone/14">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-vault-emerald/14 border border-vault-emerald/35 text-vault-emerald">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-vault-ivory text-sm tracking-tight truncate">
              Documents Vault
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-vault-emerald">
              <span className="h-1.5 w-1.5 rounded-full bg-vault-emerald animate-pulse" />
              Zero-Knowledge Ativo
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onOpenCreateTab}
          className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-vault-ivory px-3 py-2 text-xs font-semibold text-vault-canvas hover:bg-vault-stone transition cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          Nova Aba Criptografada
        </button>
      </div>

      {/* Tabs list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-6">
        <div>
          <div className="px-2 mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.14em] text-vault-muted">
            <span>Documentos &amp; Notas</span>
            <span className="tabular-nums">{docTabs.length}</span>
          </div>
          {docTabs.length === 0 ? (
            <p className="px-2 py-1 text-xs text-vault-muted/70 italic">
              Nenhuma aba de documentos
            </p>
          ) : (
            <div className="space-y-1">{docTabs.map(renderTabButton)}</div>
          )}
        </div>

        <div>
          <div className="px-2 mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.14em] text-vault-muted">
            <span>Tabelas Estruturadas</span>
            <span className="tabular-nums">{tableTabs.length}</span>
          </div>
          {tableTabs.length === 0 ? (
            <p className="px-2 py-1 text-xs text-vault-muted/70 italic">
              Nenhuma tabela criada
            </p>
          ) : (
            <div className="space-y-1">{tableTabs.map(renderTabButton)}</div>
          )}
        </div>
      </div>

      {/* Storage Quota + Account Footer */}
      <div className="p-3 border-t border-vault-stone/14 space-y-3 bg-vault-deep">
        <div className="rounded-xl border border-vault-stone/16 bg-vault-canvas p-3">
          <div className="flex items-center justify-between text-[11px] text-vault-muted mb-1.5">
            <span className="inline-flex items-center gap-1.5">
              <FolderLock className="h-3.5 w-3.5 text-vault-emerald" />
              Espaço Criptografado
            </span>
            <span className="font-medium text-vault-ivory tabular-nums">{usagePct}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-vault-surface overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                usagePct > 85 ? 'bg-vault-danger' : 'bg-vault-emerald'
              }`}
              style={{ width: `${usagePct}%` }}
            />
          </div>
          <div className="mt-1.5 text-[11px] text-vault-muted tabular-nums">
            {formatBytes(user.usedBytes)} de {formatBytes(user.quotaBytes)}
          </div>
        </div>

        <div className="flex items-center justify-between px-1">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-vault-ivory truncate">
              {user.username}
            </div>
            <div className="text-[10px] text-vault-muted uppercase tracking-[0.12em]">
              {user.role === 'admin' ? 'Administrador' : 'Usuário'}
            </div>
          </div>

          <div className="flex items-center gap-1">
            {user.role === 'admin' && (
              <button
                type="button"
                onClick={onOpenAdmin}
                title="Administração (Usuários, Convites e Quotas)"
                className="rounded-lg p-1.5 text-vault-muted hover:bg-vault-surface hover:text-vault-ivory transition cursor-pointer"
              >
                <Settings className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onLockVault}
              title="Trancar cofre (limpar chaves da memória)"
              className="rounded-lg p-1.5 text-vault-muted hover:bg-vault-surface hover:text-vault-warning transition cursor-pointer"
            >
              <Lock className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onLogout}
              title="Sair"
              className="rounded-lg p-1.5 text-vault-muted hover:bg-vault-surface hover:text-vault-danger transition cursor-pointer"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
