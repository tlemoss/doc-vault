# Documents Vault — Plataforma Zero-Knowledge Auto-Hospedável

Plataforma leve para armazenar **documentos pessoais (dados não estruturados)** e **tabelas estruturadas personalizáveis (dados financeiros e afins)** com **criptografia ponta-a-ponta Zero-Knowledge** no navegador e **controle de acesso multi-usuário por aba**.

## Garantias de Segurança (Host-Blind)

- **Chaves nunca saem do navegador:** A senha mestre passa por `PBKDF2-SHA256` (600.000 iterações) + `HKDF-SHA256` com separação de domínio:
  - `authKey` → autenticada no servidor (armazenada com hash `scrypt`). Não consegue descriptografar o cofre.
  - `masterWrappingKey` → permanece apenas na memória do navegador para descriptografar a chave privada `RSA-OAEP` (3072-bit) do usuário.
- **Tudo criptografado para o host:** Títulos de abas, descrições, nomes de arquivos, tags, notas, esquemas de colunas e linhas de tabelas são criptografados com `AES-256-GCM` antes do envio. No servidor existem apenas UUIDs, `ciphertext` no SQLite (`data/vault.db`) e arquivos binários opacos (`data/blobs/<uuid>.enc`).
- **Compartilhamento seguro por aba:** Cada aba possui uma chave simétrica própria (`tabKey`). Ao compartilhar com outro usuário (`owner`, `editor` ou `viewer`), o navegador empacota a `tabKey` com a chave pública RSA do destinatário. Após revogar alguém, o proprietário pode **rotacionar a chave da aba** atomicamente com 1 clique.
- **Chave de Recuperação offline:** Gerada localmente no cadastro; permite redefinir a senha mestre sem perda de dados e sem que o servidor conheça nenhuma chave.
- **Auto-Lock:** Chaves ficam apenas em memória RAM e são descartadas após 15 minutos de inatividade, recarregamento da página ou clique em *Trancar Cofre*.

---

## Como Rodar Localmente

### Opção 1: Com Docker (Recomendado)

```bash
docker compose up -d --build
```

Acesse: **http://localhost:3000**

### Opção 2: Diretamente com Node.js (Node 22.13+ ou 24+)

```bash
# 1. Instalar dependências (apenas na primeira vez)
npm --prefix server install
npm --prefix client install

# 2. Compilar frontend e backend
npm run build

# 3. Iniciar servidor único (API + Interface na porta 3000)
npm start
```

Para desenvolvimento com hot-reload (em dois terminais):
```bash
npm run dev:server   # Backend em http://127.0.0.1:3000
npm run dev:client   # Frontend em http://localhost:5173 (proxy para /api)
```

---

## Primeiro Acesso e Gestão de Usuários

1. No primeiro acesso, a plataforma abrirá a tela de **Configuração Inicial** para criar a conta do **Administrador**.
2. **Salve sua Chave de Recuperação** (baixe o `.txt` ou anote em local seguro offline).
3. Para adicionar outras pessoas, abra **Administração → Convites**, gere um link de convite de uso único (com quota configurável — padrão **1 GB**) e envie à pessoa.
4. O convidado escolhe sua própria senha mestre no navegador e gera seu par de chaves localmente. Depois disso, você pode compartilhar qualquer aba específica com permissão de *Leitor*, *Editor* ou *Proprietário*.

---

## Hospedagem Remota (VPS / Home Server)

A Web Crypto API exige **HTTPS** fora de `localhost`. Para publicar remotamente:

1. No `docker-compose.yml`, mude `COOKIE_SECURE=true` e mantenha a porta exposta apenas em `127.0.0.1:3000:3000`.
2. Configure um proxy reverso com HTTPS automático usando o exemplo em `Caddyfile.example` (ou Nginx + Certbot / Cloudflare Tunnel / Tailscale Serve).

## Backup

Todos os dados ficam em um único diretório `./data`:
- `data/vault.db` (banco SQLite com tudo criptografado)
- `data/blobs/` (arquivos `.enc` criptografados)

Como tudo já está criptografado na origem (Zero-Knowledge), você pode fazer backup de `./data` com segurança até mesmo em nuvens de terceiros (S3, Google Drive, Restic, Borg, etc.).
