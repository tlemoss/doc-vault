import { useState } from 'react';
import { FileText, Table2, X } from 'lucide-react';
import type { TableSchema, TabType } from '../types';
import { defaultTableSchema } from '../crypto/vault';

interface CreateTabModalProps {
  onClose: () => void;
  onCreate: (params: {
    type: TabType;
    title: string;
    description: string;
    schema?: TableSchema | null;
  }) => Promise<void>;
}

type TableTemplate = 'financeiro' | 'contas' | 'vazia';

function buildTemplateSchema(tpl: TableTemplate): TableSchema {
  if (tpl === 'financeiro') {
    return defaultTableSchema();
  }
  if (tpl === 'contas') {
    return {
      columns: [
        { id: crypto.randomUUID(), name: 'Vencimento', type: 'date' },
        { id: crypto.randomUUID(), name: 'Conta / Fornecedor', type: 'text' },
        {
          id: crypto.randomUUID(),
          name: 'Tipo',
          type: 'select',
          options: ['Fixa', 'Variável', 'Imposto', 'Cartão'],
        },
        { id: crypto.randomUUID(), name: 'Valor', type: 'currency', currency: 'BRL' },
        { id: crypto.randomUUID(), name: 'Quitada', type: 'checkbox' },
      ],
    };
  }
  return {
    columns: [
      { id: crypto.randomUUID(), name: 'Item', type: 'text' },
      { id: crypto.randomUUID(), name: 'Valor', type: 'number' },
      { id: crypto.randomUUID(), name: 'Data', type: 'date' },
    ],
  };
}

export function CreateTabModal({ onClose, onCreate }: CreateTabModalProps) {
  const [type, setType] = useState<TabType>('documents');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState<TableTemplate>('financeiro');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setError('Dê um nome para a aba.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        type,
        title: title.trim(),
        description: description.trim(),
        schema: type === 'table' ? buildTemplateSchema(template) : null,
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erro ao criar aba.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-vault-deep/80 backdrop-blur-xs p-4">
      <div className="w-full max-w-md rounded-2xl border border-vault-stone/30 bg-vault-surface p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-vault-ivory tracking-tight">
            Nova Aba Criptografada
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-vault-muted hover:bg-vault-hover hover:text-vault-ivory cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="text-xs text-vault-muted mb-4 leading-relaxed">
          Uma chave exclusiva AES-256-GCM será gerada no seu navegador para esta aba. Nem o nome da
          aba fica visível para o servidor.
        </p>

        {error && (
          <div className="mb-4 rounded-xl border border-vault-danger/40 bg-vault-danger/10 p-3 text-xs text-vault-danger">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setType('documents')}
              className={`rounded-xl border p-3.5 text-left transition cursor-pointer ${
                type === 'documents'
                  ? 'border-vault-emerald/45 bg-vault-emerald/14 text-vault-ivory'
                  : 'border-vault-stone/18 bg-vault-deep/70 text-vault-body hover:border-vault-stone/35'
              }`}
            >
              <FileText
                className={`h-5 w-5 mb-2 ${
                  type === 'documents' ? 'text-vault-emerald' : 'text-vault-stone'
                }`}
              />
              <div className="text-sm font-semibold text-vault-ivory">Documentos</div>
              <div className="text-[11px] text-vault-muted mt-0.5">
                PDFs, imagens, recibos e notas pessoais
              </div>
            </button>

            <button
              type="button"
              onClick={() => setType('table')}
              className={`rounded-xl border p-3.5 text-left transition cursor-pointer ${
                type === 'table'
                  ? 'border-vault-emerald/45 bg-vault-emerald/14 text-vault-ivory'
                  : 'border-vault-stone/18 bg-vault-deep/70 text-vault-body hover:border-vault-stone/35'
              }`}
            >
              <Table2
                className={`h-5 w-5 mb-2 ${
                  type === 'table' ? 'text-vault-emerald' : 'text-vault-stone'
                }`}
              />
              <div className="text-sm font-semibold text-vault-ivory">Tabela</div>
              <div className="text-[11px] text-vault-muted mt-0.5">
                Dados estruturados, financeiro e totais
              </div>
            </button>
          </div>

          <div>
            <label className="block text-xs font-medium text-vault-stone mb-1.5">
              Nome da aba
            </label>
            <input
              type="text"
              required
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                type === 'documents'
                  ? 'ex: Documentos Pessoais, Imposto de Renda'
                  : 'ex: Finanças 2026, Contas da Casa'
              }
              className="w-full rounded-xl border border-vault-stone/22 bg-vault-deep px-3.5 py-2 text-sm text-vault-ivory placeholder-vault-muted/70 focus:border-vault-stone/60 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-vault-stone mb-1.5">
              Descrição (opcional, também criptografada)
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Breve resumo do conteúdo desta aba"
              className="w-full rounded-xl border border-vault-stone/22 bg-vault-deep px-3.5 py-2 text-sm text-vault-ivory placeholder-vault-muted/70 focus:border-vault-stone/60 focus:outline-none"
            />
          </div>

          {type === 'table' && (
            <div>
              <label className="block text-xs font-medium text-vault-stone mb-1.5">
                Modelo inicial de colunas
              </label>
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value as TableTemplate)}
                className="w-full rounded-xl border border-vault-stone/22 bg-vault-deep px-3.5 py-2 text-sm text-vault-ivory focus:border-vault-stone/60 focus:outline-none"
              >
                <option value="financeiro">
                  Financeiro Mensal (Data, Descrição, Categoria, Valor R$, Pago)
                </option>
                <option value="contas">
                  Contas a Pagar (Vencimento, Fornecedor, Tipo, Valor R$, Quitada)
                </option>
                <option value="vazia">Tabela Simples (Item, Valor, Data)</option>
              </select>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-vault-stone/25 px-4 py-2 text-xs font-medium text-vault-stone hover:bg-vault-hover cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl bg-vault-ivory px-4 py-2 text-xs font-semibold text-vault-canvas hover:bg-vault-stone disabled:opacity-50 cursor-pointer"
            >
              {busy ? 'Gerando chave e criando...' : 'Criar Aba'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
