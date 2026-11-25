import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  KeyRound,
  Lock,
  LogOut,
  ShieldCheck,
  UserPlus,
} from 'lucide-react';
import { api } from '../api/client';
import {
  createRecoveryResetBundle,
  createRegistrationBundle,
  decryptPrivateKey,
  deriveMasterKeys,
} from '../crypto/engine';
import type { CurrentUser } from '../types';
import { formatBytes } from '../utils/format';

interface AuthScreenProps {
  initialized: boolean;
  lockedUser: CurrentUser | null;
  inviteToken: string | null;
  onAuthenticated: (user: CurrentUser, privateKey: CryptoKey) => void;
  onLogout: () => Promise<void>;
}

type Mode = 'setup' | 'invite' | 'login' | 'unlock' | 'recovery';

export function AuthScreen({
  initialized,
  lockedUser,
  inviteToken,
  onAuthenticated,
  onLogout,
}: AuthScreenProps) {
  const initialMode: Mode = lockedUser
    ? 'unlock'
    : !initialized
      ? 'setup'
      : inviteToken
        ? 'invite'
        : 'login';

  const [mode, setMode] = useState<Mode>(initialMode);
  const [username, setUsername] = useState(lockedUser?.username ?? '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [recoveryKeyInput, setRecoveryKeyInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Invite verification state
  const [inviteInfo, setInviteInfo] = useState<{
    username: string | null;
    role: string;
    quotaBytes: number;
  } | null>(null);

  // One-time recovery key display after registration/setup
  const [pendingRecovery, setPendingRecovery] = useState<{
    recoveryKey: string;
    user: CurrentUser;
    privateKey: CryptoKey;
  } | null>(null);
  const [copiedRecovery, setCopiedRecovery] = useState(false);
  const [confirmedRecovery, setConfirmedRecovery] = useState(false);

  useEffect(() => {
    if (lockedUser) {
      setMode('unlock');
      setUsername(lockedUser.username);
    } else if (!initialized) {
      setMode('setup');
    } else if (inviteToken) {
      setMode('invite');
    } else if (mode === 'unlock' || mode === 'setup') {
      setMode('login');
    }
  }, [initialized, lockedUser, inviteToken]);

  useEffect(() => {
    if (mode === 'invite' && inviteToken) {
      setError(null);
      api.auth
        .checkInvite(inviteToken)
        .then((res) => {
          setInviteInfo({
            username: res.username,
            role: res.role,
            quotaBytes: res.quotaBytes,
          });
          if (res.username) {
            setUsername(res.username);
          }
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Convite inválido.');
          setInviteInfo(null);
        });
    }
  }, [mode, inviteToken]);

  async function handleSetupOrRegister(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (username.trim().length < 3) {
      setError('O usuário deve ter pelo menos 3 caracteres.');
      return;
    }
    if (password.length < 10) {
      setError('Use uma senha mestre forte com pelo menos 10 caracteres.');
      return;
    }
    if (password !== confirmPassword) {
      setError('As senhas não coincidem.');
      return;
    }

    setBusy(true);
    try {
      const bundle = await createRegistrationBundle(username.trim(), password);
      const res =
        mode === 'setup'
          ? await api.auth.setup(bundle.payload)
          : await api.auth.register({
              ...bundle.payload,
              inviteToken: inviteToken!,
            });

      // Clear ?invite= from URL if present
      if (inviteToken) {
        window.history.replaceState({}, '', window.location.pathname);
      }

      setPendingRecovery({
        recoveryKey: bundle.recoveryKey,
        user: res.user,
        privateKey: bundle.privateKey,
      });
      setPassword('');
      setConfirmPassword('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erro ao criar conta.');
    } finally {
      setBusy(false);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError('Informe usuário e senha mestre.');
      return;
    }

    setBusy(true);
    try {
      const challenge = await api.auth.loginChallenge(username.trim());
      const derived = await deriveMasterKeys(
        password,
        challenge.kdfSalt,
        challenge.kdfIterations
      );
      const { user } = await api.auth.login(username.trim(), derived.authKeyB64);
      const privateKey = await decryptPrivateKey(
        user.encryptedPrivateKey,
        user.privateKeyIv,
        derived.masterWrappingKey
      );
      setPassword('');
      onAuthenticated(user, privateKey);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : 'Usuário ou senha mestre incorretos.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    if (!lockedUser) return;
    setError(null);
    if (!password) {
      setError('Digite sua senha mestre para desbloquear o cofre.');
      return;
    }

    setBusy(true);
    try {
      const derived = await deriveMasterKeys(
        password,
        lockedUser.kdfSalt,
        lockedUser.kdfIterations
      );
      const privateKey = await decryptPrivateKey(
        lockedUser.encryptedPrivateKey,
        lockedUser.privateKeyIv,
        derived.masterWrappingKey
      );
      setPassword('');
      onAuthenticated(lockedUser, privateKey);
    } catch {
      setError('Senha mestre incorreta. Não foi possível descriptografar sua chave privada.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRecovery(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !recoveryKeyInput.trim()) {
      setError('Informe o usuário e a chave de recuperação.');
      return;
    }
    if (password.length < 10) {
      setError('A nova senha mestre deve ter pelo menos 10 caracteres.');
      return;
    }
    if (password !== confirmPassword) {
      setError('As novas senhas não coincidem.');
      return;
    }

    setBusy(true);
    try {
      const challenge = await api.auth.recoveryChallenge(username.trim());
      const bundle = await createRecoveryResetBundle(
        username.trim(),
        recoveryKeyInput.trim(),
        challenge.recoverySalt,
        challenge.recoveryEncryptedPrivateKey,
        challenge.recoveryIv,
        password
      );
      const { user } = await api.auth.recoveryReset(bundle.payload);
      setPassword('');
      setConfirmPassword('');
      setRecoveryKeyInput('');
      onAuthenticated(user, bundle.privateKey);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : 'Falha na recuperação. Verifique o usuário e a chave de recuperação.'
      );
    } finally {
      setBusy(false);
    }
  }

  function downloadRecoveryFile() {
    if (!pendingRecovery) return;
    const text = [
      'DOCUMENTS VAULT — CHAVE DE RECUPERAÇÃO ZERO-KNOWLEDGE',
      '======================================================',
      `Usuário: ${pendingRecovery.user.username}`,
      `Data: ${new Date().toLocaleString('pt-BR')}`,
      '',
      'Chave de Recuperação:',
      pendingRecovery.recoveryKey,
      '',
      'IMPORTANTE: Guarde este arquivo em local seguro offline (ex: cofre físico ou gerenciador de senhas).',
      'O servidor NÃO possui acesso à sua senha nem a esta chave.',
    ].join('\n');

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `documents-vault-recovery-${pendingRecovery.user.username}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Recovery Key confirmation step right after account creation
  if (pendingRecovery) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4">
        <div className="w-full max-w-lg rounded-2xl border border-amber-500/30 bg-slate-900/90 p-7 shadow-2xl">
          <div className="flex items-center gap-3 text-amber-400 mb-4">
            <AlertTriangle className="h-7 w-7 shrink-0" />
            <div>
              <h1 className="text-xl font-semibold text-slate-100">
                Salve sua Chave de Recuperação
              </h1>
              <p className="text-xs text-slate-400">
                Ela é exibida uma única vez e nunca é enviada ao servidor.
              </p>
            </div>
          </div>

          <p className="text-sm text-slate-300 leading-relaxed mb-4">
            Como esta plataforma é <strong className="text-emerald-400">Zero-Knowledge</strong>,
            ninguém (nem o administrador nem o host) consegue recuperar sua senha mestre caso você
            a esqueça. Guarde a chave abaixo em um local seguro offline:
          </p>

          <div className="rounded-xl border border-slate-700 bg-slate-950 p-4 font-mono text-sm text-emerald-300 break-all tracking-wider select-all mb-4">
            {pendingRecovery.recoveryKey}
          </div>

          <div className="flex flex-wrap gap-2 mb-5">
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(pendingRecovery.recoveryKey);
                setCopiedRecovery(true);
                setTimeout(() => setCopiedRecovery(false), 2000);
              }}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700 transition cursor-pointer"
            >
              {copiedRecovery ? (
                <>
                  <Check className="h-4 w-4 text-emerald-400" />
                  Copiada!
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  Copiar chave
                </>
              )}
            </button>
            <button
              type="button"
              onClick={downloadRecoveryFile}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700 transition cursor-pointer"
            >
              <Download className="h-4 w-4" />
              Baixar .txt
            </button>
          </div>

          <label className="flex items-start gap-3 text-sm text-slate-300 mb-5 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmedRecovery}
              onChange={(e) => setConfirmedRecovery(e.target.checked)}
              className="mt-1 rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500"
            />
            <span>
              Confirmo que salvei minha chave de recuperação em local seguro e entendo que ela é a
              única forma de recuperar meu cofre se eu esquecer minha senha mestre.
            </span>
          </label>

          <button
            type="button"
            disabled={!confirmedRecovery}
            onClick={() =>
              onAuthenticated(pendingRecovery.user, pendingRecovery.privateKey)
            }
            className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
          >
            Entrar no Cofre Criptografado
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/90 p-7 shadow-2xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-100">Documents Vault</h1>
            <p className="text-xs text-emerald-400/90">
              Criptografia Zero-Knowledge no Navegador
            </p>
          </div>
        </div>

        {mode === 'setup' && (
          <div className="mb-5 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3.5 text-xs text-emerald-200 leading-relaxed">
            <strong>Configuração Inicial:</strong> Crie a primeira conta de{' '}
            <strong>Administrador</strong>. Suas chaves criptográficas serão geradas localmente no
            seu navegador — o host nunca terá acesso à sua senha nem aos seus dados.
          </div>
        )}

        {mode === 'invite' && inviteInfo && (
          <div className="mb-5 rounded-xl border border-sky-500/25 bg-sky-500/10 p-3.5 text-xs text-sky-200 space-y-1">
            <div className="font-semibold flex items-center gap-1.5">
              <UserPlus className="h-4 w-4" />
              Convite válido para criar sua conta
            </div>
            <div>
              Perfil: <strong>{inviteInfo.role === 'admin' ? 'Administrador' : 'Usuário'}</strong> ·
              Espaço: <strong>{formatBytes(inviteInfo.quotaBytes)}</strong>
            </div>
          </div>
        )}

        {mode === 'unlock' && lockedUser && (
          <div className="mb-5 rounded-xl border border-slate-700 bg-slate-800/60 p-3.5 text-xs text-slate-300">
            Sessão ativa como <strong className="text-slate-100">{lockedUser.username}</strong>.
            Digite sua senha mestre para descriptografar suas chaves localmente na memória.
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-200">
            {error}
          </div>
        )}

        <form
          onSubmit={
            mode === 'setup' || mode === 'invite'
              ? handleSetupOrRegister
              : mode === 'unlock'
                ? handleUnlock
                : mode === 'recovery'
                  ? handleRecovery
                  : handleLogin
          }
          className="space-y-4"
        >
          {mode !== 'unlock' && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Nome de usuário
              </label>
              <input
                type="text"
                autoComplete="username"
                required
                disabled={mode === 'invite' && Boolean(inviteInfo?.username)}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="ex: thiago"
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none disabled:opacity-60"
              />
            </div>
          )}

          {mode === 'recovery' && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Chave de Recuperação (64 caracteres hex)
              </label>
              <textarea
                rows={2}
                required
                value={recoveryKeyInput}
                onChange={(e) => setRecoveryKeyInput(e.target.value)}
                placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX-..."
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2.5 font-mono text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              {mode === 'recovery' ? 'Nova Senha Mestre' : 'Senha Mestre'}
            </label>
            <input
              type="password"
              autoComplete={
                mode === 'setup' || mode === 'invite' || mode === 'recovery'
                  ? 'new-password'
                  : 'current-password'
              }
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={
                mode === 'setup' || mode === 'invite' || mode === 'recovery'
                  ? 'Mínimo 10 caracteres fortes'
                  : 'Digite sua senha mestre'
              }
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          {(mode === 'setup' || mode === 'invite' || mode === 'recovery') && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Confirmar Senha Mestre
              </label>
              <input
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repita a senha mestre"
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={busy || (mode === 'invite' && !inviteInfo)}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 transition cursor-pointer"
          >
            <Lock className="h-4 w-4" />
            {busy
              ? 'Derivando chaves criptográficas...'
              : mode === 'setup'
                ? 'Criar Conta Admin e Inicializar Cofre'
                : mode === 'invite'
                  ? 'Criar Minha Conta Criptografada'
                  : mode === 'unlock'
                    ? 'Desbloquear Cofre'
                    : mode === 'recovery'
                      ? 'Recuperar Acesso e Redefinir Senha'
                      : 'Entrar e Descriptografar Cofre'}
          </button>
        </form>

        <div className="mt-5 pt-4 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
          {mode === 'login' && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode('recovery');
              }}
              className="inline-flex items-center gap-1.5 text-slate-400 hover:text-emerald-400 transition cursor-pointer"
            >
              <KeyRound className="h-3.5 w-3.5" />
              Esqueci a senha (usar chave de recuperação)
            </button>
          )}
          {mode === 'recovery' && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode('login');
              }}
              className="text-slate-400 hover:text-emerald-400 transition cursor-pointer"
            >
              ← Voltar para o login
            </button>
          )}
          {mode === 'unlock' && (
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex items-center gap-1.5 text-slate-400 hover:text-rose-400 transition cursor-pointer"
            >
              <LogOut className="h-3.5 w-3.5" />
              Encerrar sessão / trocar usuário
            </button>
          )}
          {mode === 'invite' && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode('login');
              }}
              className="text-slate-400 hover:text-emerald-400 transition cursor-pointer"
            >
              Já tenho conta — fazer login
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
