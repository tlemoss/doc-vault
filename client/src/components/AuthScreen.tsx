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

  const [inviteInfo, setInviteInfo] = useState<{
    username: string | null;
    role: string;
    quotaBytes: number;
  } | null>(null);

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

  if (pendingRecovery) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-vault-canvas p-4 py-6">
        <div className="w-full max-w-lg rounded-2xl border border-vault-warning/40 bg-vault-surface p-5 sm:p-7 shadow-2xl">
          <div className="flex items-center gap-3 text-vault-warning mb-4">
            <AlertTriangle className="h-7 w-7 shrink-0" />
            <div>
              <h1 className="text-xl font-semibold text-vault-ivory tracking-tight">
                Salve sua Chave de Recuperação
              </h1>
              <p className="text-xs text-vault-muted">
                Ela é exibida uma única vez e nunca é enviada ao servidor.
              </p>
            </div>
          </div>

          <p className="text-sm text-vault-body leading-relaxed mb-4">
            Como esta plataforma é{' '}
            <strong className="text-vault-emerald">Zero-Knowledge</strong>, ninguém (nem o
            administrador nem o host) consegue recuperar sua senha mestre caso você a esqueça.
            Guarde a chave abaixo em um local seguro offline:
          </p>

          <div className="rounded-xl border border-vault-stone/25 bg-vault-deep p-4 font-mono text-sm text-vault-ivory break-all tracking-wider select-all mb-4">
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
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border border-vault-stone/25 bg-vault-canvas px-3 py-2 text-sm font-medium text-vault-stone hover:bg-vault-hover transition cursor-pointer"
            >
              {copiedRecovery ? (
                <>
                  <Check className="h-4 w-4 text-vault-emerald" />
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
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border border-vault-stone/25 bg-vault-canvas px-3 py-2 text-sm font-medium text-vault-stone hover:bg-vault-hover transition cursor-pointer"
            >
              <Download className="h-4 w-4" />
              Baixar .txt
            </button>
          </div>

          <label className="flex items-start gap-3 text-sm text-vault-body mb-5 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmedRecovery}
              onChange={(e) => setConfirmedRecovery(e.target.checked)}
              className="mt-1 rounded border-vault-stone/30 bg-vault-deep accent-vault-emerald"
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
            className="w-full rounded-xl bg-vault-ivory px-4 py-2.5 text-sm font-semibold text-vault-canvas hover:bg-vault-stone disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
          >
            Entrar no Cofre Criptografado
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-vault-canvas p-4 py-6">
      <div className="w-full max-w-md rounded-2xl border border-vault-stone/25 bg-vault-surface p-5 sm:p-7 shadow-2xl">
        <div className="flex items-center gap-3.5 mb-6">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-vault-emerald/15 border border-vault-emerald/35 text-vault-emerald">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-vault-ivory tracking-tight">
              Documents Vault
            </h1>
            <p className="text-xs text-vault-emerald">
              Criptografia Zero-Knowledge no Navegador
            </p>
          </div>
        </div>

        {mode === 'setup' && (
          <div className="mb-5 rounded-xl border border-vault-stone/20 bg-vault-deep/80 p-3.5 text-xs text-vault-body leading-relaxed">
            <strong className="text-vault-ivory">Configuração Inicial:</strong> Crie a primeira
            conta de <strong className="text-vault-ivory">Administrador</strong>. Suas chaves
            criptográficas serão geradas localmente no navegador — o host nunca terá acesso à sua
            senha nem aos seus dados.
          </div>
        )}

        {mode === 'invite' && inviteInfo && (
          <div className="mb-5 rounded-xl border border-vault-emerald/30 bg-vault-emerald/10 p-3.5 text-xs text-vault-ivory space-y-1">
            <div className="font-semibold flex items-center gap-1.5 text-vault-emerald">
              <UserPlus className="h-4 w-4" />
              Convite válido para criar sua conta
            </div>
            <div className="text-vault-body">
              Perfil:{' '}
              <strong className="text-vault-ivory">
                {inviteInfo.role === 'admin' ? 'Administrador' : 'Usuário'}
              </strong>{' '}
              · Espaço:{' '}
              <strong className="text-vault-ivory tabular-nums">
                {formatBytes(inviteInfo.quotaBytes)}
              </strong>
            </div>
          </div>
        )}

        {mode === 'unlock' && lockedUser && (
          <div className="mb-5 rounded-xl border border-vault-stone/20 bg-vault-deep/80 p-3.5 text-xs text-vault-body">
            Sessão ativa como{' '}
            <strong className="text-vault-ivory">{lockedUser.username}</strong>. Digite sua senha
            mestre para descriptografar suas chaves localmente na memória.
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-xl border border-vault-danger/40 bg-vault-danger/10 px-3.5 py-2.5 text-xs text-vault-danger">
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
              <label className="block text-xs font-medium text-vault-stone mb-1.5">
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
                className="w-full rounded-xl border border-vault-stone/22 bg-vault-deep px-3.5 py-2.5 text-sm text-vault-ivory placeholder-vault-muted/70 focus:border-vault-stone/60 focus:outline-none disabled:opacity-60 transition"
              />
            </div>
          )}

          {mode === 'recovery' && (
            <div>
              <label className="block text-xs font-medium text-vault-stone mb-1.5">
                Chave de Recuperação (64 caracteres hex)
              </label>
              <textarea
                rows={2}
                required
                value={recoveryKeyInput}
                onChange={(e) => setRecoveryKeyInput(e.target.value)}
                placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX-..."
                className="w-full rounded-xl border border-vault-stone/22 bg-vault-deep px-3.5 py-2.5 font-mono text-xs text-vault-ivory placeholder-vault-muted/70 focus:border-vault-stone/60 focus:outline-none transition"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-vault-stone mb-1.5">
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
              className="w-full rounded-xl border border-vault-stone/22 bg-vault-deep px-3.5 py-2.5 text-sm text-vault-ivory placeholder-vault-muted/70 focus:border-vault-stone/60 focus:outline-none transition"
            />
          </div>

          {(mode === 'setup' || mode === 'invite' || mode === 'recovery') && (
            <div>
              <label className="block text-xs font-medium text-vault-stone mb-1.5">
                Confirmar Senha Mestre
              </label>
              <input
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repita a senha mestre"
                className="w-full rounded-xl border border-vault-stone/22 bg-vault-deep px-3.5 py-2.5 text-sm text-vault-ivory placeholder-vault-muted/70 focus:border-vault-stone/60 focus:outline-none transition"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={busy || (mode === 'invite' && !inviteInfo)}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-vault-ivory px-4 py-2.5 text-sm font-semibold text-vault-canvas hover:bg-vault-stone disabled:opacity-50 transition cursor-pointer"
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

        <div className="mt-5 pt-4 border-t border-vault-stone/15 flex items-center justify-between text-xs text-vault-muted">
          {mode === 'login' && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode('recovery');
              }}
              className="inline-flex items-center gap-1.5 text-vault-muted hover:text-vault-ivory transition cursor-pointer"
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
              className="text-vault-muted hover:text-vault-ivory transition cursor-pointer"
            >
              ← Voltar para o login
            </button>
          )}
          {mode === 'unlock' && (
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex items-center gap-1.5 text-vault-muted hover:text-vault-danger transition cursor-pointer"
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
              className="text-vault-muted hover:text-vault-ivory transition cursor-pointer"
            >
              Já tenho conta — fazer login
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
