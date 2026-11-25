import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderLock, Plus, ShieldCheck } from 'lucide-react';
import { api } from './api/client';
import { createEncryptedTab, decryptTabRecord } from './crypto/vault';
import type { CurrentUser, DecryptedTab, TableSchema, TabType } from './types';
import { AuthScreen } from './components/AuthScreen';
import { Sidebar } from './components/Sidebar';
import { CreateTabModal } from './components/CreateTabModal';
import { DocumentTab } from './components/DocumentTab';
import { TableTab } from './components/TableTab';
import { ShareModal } from './components/ShareModal';
import { AdminModal } from './components/AdminModal';

const AUTO_LOCK_MS = 15 * 60 * 1000; // 15 minutes of inactivity

export function App() {
  const [booting, setBooting] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [maxFileSizeBytes, setMaxFileSizeBytes] = useState(100 * 1024 * 1024);
  const [defaultQuotaBytes, setDefaultQuotaBytes] = useState(1024 * 1024 * 1024);

  const [user, setUser] = useState<CurrentUser | null>(null);
  // Private key stays STRICTLY in React state (RAM only — never persisted to localStorage!)
  const [privateKey, setPrivateKey] = useState<CryptoKey | null>(null);

  const [tabs, setTabs] = useState<DecryptedTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const [showCreateTab, setShowCreateTab] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);

  const [toast, setToast] = useState<{ msg: string; tone: 'ok' | 'err' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const inviteToken = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('invite');
  }, []);

  const notify = useCallback((msg: string, tone: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tone });
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  const refreshAuthStatus = useCallback(async () => {
    try {
      const status = await api.auth.status();
      setInitialized(status.initialized);
      setMaxFileSizeBytes(status.maxFileSizeBytes);
      setDefaultQuotaBytes(status.defaultQuotaBytes);
      setUser(status.user);
    } catch (err: unknown) {
      notify(
        err instanceof Error ? err.message : 'Erro ao conectar ao servidor.',
        'err'
      );
    } finally {
      setBooting(false);
    }
  }, [notify]);

  useEffect(() => {
    void refreshAuthStatus();
  }, [refreshAuthStatus]);

  const loadTabs = useCallback(
    async (key: CryptoKey) => {
      try {
        const { tabs: encryptedTabs } = await api.tabs.list();
        const decrypted: DecryptedTab[] = [];
        for (const t of encryptedTabs) {
          try {
            decrypted.push(await decryptTabRecord(t, key));
          } catch {
            // Skip any tab that cannot be decrypted with current key
          }
        }
        setTabs(decrypted);
        setActiveTabId((prev) =>
          prev && decrypted.some((t) => t.id === prev)
            ? prev
            : (decrypted[0]?.id ?? null)
        );
      } catch (err: unknown) {
        notify(
          err instanceof Error ? err.message : 'Erro ao carregar abas criptografadas.',
          'err'
        );
      }
    },
    [notify]
  );

  // Auto-lock after 15 min of inactivity when unlocked
  useEffect(() => {
    if (!privateKey) return;
    let timer = window.setTimeout(() => {
      setPrivateKey(null);
      setTabs([]);
      notify('Cofre trancado automaticamente por inatividade.');
    }, AUTO_LOCK_MS);

    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setPrivateKey(null);
        setTabs([]);
        notify('Cofre trancado automaticamente por inatividade.');
      }, AUTO_LOCK_MS);
    };

    const events = ['mousemove', 'keydown', 'click', 'touchstart'];
    events.forEach((ev) => window.addEventListener(ev, reset, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((ev) => window.removeEventListener(ev, reset));
    };
  }, [privateKey, notify]);

  function handleAuthenticated(authedUser: CurrentUser, unlockedKey: CryptoKey) {
    setInitialized(true);
    setUser(authedUser);
    setPrivateKey(unlockedKey);
    void loadTabs(unlockedKey);
  }

  function handleLockVault() {
    setPrivateKey(null);
    setTabs([]);
    setShowCreateTab(false);
    setShowShareModal(false);
    setShowAdminModal(false);
    notify('Cofre trancado. Chaves removidas da memória.');
  }

  async function handleLogout() {
    await api.auth.logout().catch(() => {});
    setUser(null);
    setPrivateKey(null);
    setTabs([]);
    setActiveTabId(null);
    setShowCreateTab(false);
    setShowShareModal(false);
    setShowAdminModal(false);
  }

  async function handleCreateTab(params: {
    type: TabType;
    title: string;
    description: string;
    schema?: TableSchema | null;
  }) {
    if (!user) return;
    const created = await createEncryptedTab({
      type: params.type,
      meta: {
        title: params.title,
        description: params.description,
        icon: params.type === 'documents' ? 'file' : 'table',
      },
      schema: params.schema,
      userPublicKeyB64: user.publicKey,
    });
    setTabs((prev) => [...prev, created]);
    setActiveTabId(created.id);
    notify(`Aba "${created.meta.title}" criada e criptografada.`);
  }

  async function handleDeleteTab(tab: DecryptedTab) {
    if (
      !window.confirm(
        `Excluir permanentemente a aba "${tab.meta.title}" e todos os seus dados criptografados?`
      )
    ) {
      return;
    }
    try {
      await api.tabs.delete(tab.id);
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== tab.id);
        setActiveTabId(next[0]?.id ?? null);
        return next;
      });
      await refreshAuthStatus();
      notify(`Aba "${tab.meta.title}" excluída.`);
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'Erro ao excluir aba.', 'err');
    }
  }

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  if (booting) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-400 text-sm gap-2">
        <ShieldCheck className="h-5 w-5 text-emerald-400 animate-pulse" />
        Inicializando ambiente Zero-Knowledge...
      </div>
    );
  }

  if (!user || !privateKey) {
    return (
      <>
        <AuthScreen
          initialized={initialized}
          lockedUser={user}
          inviteToken={inviteToken}
          onAuthenticated={handleAuthenticated}
          onLogout={handleLogout}
        />
        {toast && (
          <div
            className={`fixed bottom-5 right-5 z-50 rounded-xl border px-4 py-2.5 text-xs font-medium shadow-xl ${
              toast.tone === 'err'
                ? 'border-rose-500/40 bg-rose-950/90 text-rose-200'
                : 'border-emerald-500/40 bg-slate-900/95 text-emerald-200'
            }`}
          >
            {toast.msg}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex overflow-hidden">
      <Sidebar
        user={user}
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTabId}
        onOpenCreateTab={() => setShowCreateTab(true)}
        onOpenAdmin={() => setShowAdminModal(true)}
        onLockVault={handleLockVault}
        onLogout={handleLogout}
      />

      {activeTab ? (
        activeTab.type === 'documents' ? (
          <DocumentTab
            key={`${activeTab.id}-${activeTab.keyVersion}`}
            tab={activeTab}
            maxFileSizeBytes={maxFileSizeBytes}
            onQuotaChanged={(usedBytes) =>
              setUser((prev) => (prev ? { ...prev, usedBytes } : prev))
            }
            onOpenShare={() => setShowShareModal(true)}
            onDeleteTab={() => handleDeleteTab(activeTab)}
            onNotify={notify}
          />
        ) : (
          <TableTab
            key={`${activeTab.id}-${activeTab.keyVersion}`}
            tab={activeTab}
            onSchemaUpdated={(tabId, nextSchema) =>
              setTabs((prev) =>
                prev.map((t) => (t.id === tabId ? { ...t, schema: nextSchema } : t))
              )
            }
            onQuotaChanged={(usedBytes) =>
              setUser((prev) => (prev ? { ...prev, usedBytes } : prev))
            }
            onOpenShare={() => setShowShareModal(true)}
            onDeleteTab={() => handleDeleteTab(activeTab)}
            onNotify={notify}
          />
        )
      ) : (
        <main className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md text-center space-y-4">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-400">
              <FolderLock className="h-7 w-7" />
            </div>
            <h2 className="text-xl font-bold text-slate-100">Seu Cofre Está Pronto</h2>
            <p className="text-sm text-slate-400 leading-relaxed">
              Crie sua primeira aba para guardar <strong>documentos pessoais criptografados</strong>{' '}
              (PDFs, recibos, notas) ou montar <strong>tabelas estruturadas</strong> (controle
              financeiro, contas e investimentos).
            </p>
            <button
              type="button"
              onClick={() => setShowCreateTab(true)}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 transition cursor-pointer"
            >
              <Plus className="h-4 w-4" />
              Criar Primeira Aba
            </button>
          </div>
        </main>
      )}

      {showCreateTab && (
        <CreateTabModal
          onClose={() => setShowCreateTab(false)}
          onCreate={handleCreateTab}
        />
      )}

      {showShareModal && activeTab && (
        <ShareModal
          tab={activeTab}
          currentUserId={user.id}
          onClose={() => setShowShareModal(false)}
          onUpdated={(newTabKey, memberCount) => {
            setTabs((prev) =>
              prev.map((t) =>
                t.id === activeTab.id
                  ? {
                      ...t,
                      tabKey: newTabKey ?? t.tabKey,
                      keyVersion: newTabKey ? t.keyVersion + 1 : t.keyVersion,
                      memberCount: memberCount ?? t.memberCount,
                    }
                  : t
              )
            );
          }}
          onNotify={notify}
        />
      )}

      {showAdminModal && user.role === 'admin' && (
        <AdminModal
          currentUserId={user.id}
          defaultQuotaBytes={defaultQuotaBytes}
          onClose={() => setShowAdminModal(false)}
          onRefreshCurrentUser={refreshAuthStatus}
          onNotify={notify}
        />
      )}

      {toast && (
        <div
          className={`fixed bottom-5 right-5 z-50 rounded-xl border px-4 py-2.5 text-xs font-medium shadow-xl ${
            toast.tone === 'err'
              ? 'border-rose-500/40 bg-rose-950/90 text-rose-200'
              : 'border-emerald-500/40 bg-slate-900/95 text-emerald-200'
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
