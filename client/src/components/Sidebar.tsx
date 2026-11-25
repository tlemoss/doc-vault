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
            ? 'bg-emerald-500/15 text-emerald-200 border border-emerald-500/30'
            : 'text-slate-300 hover:bg-slate-800/70 border border-transparent'
        }`}
      >
        {tab.type === 'documents' ? (
          <FileText
            className={`h-4 w-4 shrink-0 ${active ? 'text-emerald-400' : 'text-slate-400'}`}
          />
        ) : (
          <Table2
            className={`h-4 w-4 shrink-0 ${active ? 'text-emerald-400' : 'text-slate-400'}`}
          />
        )}
        <span className="truncate flex-1 font-medium">{tab.meta.title}</span>
        {tab.memberCount > 1 && (
          <span
            title={`Compartilhada com ${tab.memberCount} pessoas`}
            className="inline-flex items-center gap-0.5 rounded-md bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300"
          >
            <Users className="h-2.5 w-2.5" />
            {tab.memberCount}
          </span>
        )}
      </button>
    );
  }

  return (
    <aside className="w-72 shrink-0 border-r border-slate-800 bg-slate-900/70 flex flex-col h-screen">
      {/* Header */}
      <div className="p-4 border-b border-slate-800">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="font-bold text-slate-100 text-sm truncate">Documents Vault</div>
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Zero-Knowledge Ativo
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onOpenCreateTab}
          className="mt-3.5 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 transition cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          Nova Aba Criptografada
        </button>
      </div>

      {/* Tabs list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-5">
        <div>
          <div className="px-2 mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            <span>Documentos & Notas</span>
            <span>{docTabs.length}</span>
          </div>
          {docTabs.length === 0 ? (
            <p className="px-2 py-1 text-xs text-slate-500 italic">
              Nenhuma aba de documentos
            </p>
          ) : (
            <div className="space-y-1">{docTabs.map(renderTabButton)}</div>
          )}
        </div>

        <div>
          <div className="px-2 mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            <span>Tabelas Estruturadas</span>
            <span>{tableTabs.length}</span>
          </div>
          {tableTabs.length === 0 ? (
            <p className="px-2 py-1 text-xs text-slate-500 italic">
              Nenhuma tabela criada
            </p>
          ) : (
            <div className="space-y-1">{tableTabs.map(renderTabButton)}</div>
          )}
        </div>
      </div>

      {/* Storage Quota + Account Footer */}
      <div className="p-3 border-t border-slate-800 space-y-3 bg-slate-950/40">
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-2.5">
          <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1.5">
            <span className="inline-flex items-center gap-1">
              <FolderLock className="h-3 w-3 text-emerald-400" />
              Espaço Criptografado
            </span>
            <span className="font-medium text-slate-200">{usagePct}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                usagePct > 85 ? 'bg-rose-500' : 'bg-emerald-500'
              }`}
              style={{ width: `${usagePct}%` }}
            />
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {formatBytes(user.usedBytes)} de {formatBytes(user.quotaBytes)}
          </div>
        </div>

        <div className="flex items-center justify-between px-1">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-200 truncate">
              {user.username}
            </div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider">
              {user.role === 'admin' ? 'Administrador' : 'Usuário'}
            </div>
          </div>

          <div className="flex items-center gap-1">
            {user.role === 'admin' && (
              <button
                type="button"
                onClick={onOpenAdmin}
                title="Administração (Usuários, Convites e Quotas)"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition cursor-pointer"
              >
                <Settings className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onLockVault}
              title="Trancar cofre (limpar chaves da memória)"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-amber-400 transition cursor-pointer"
            >
              <Lock className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onLogout}
              title="Sair"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-rose-400 transition cursor-pointer"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
