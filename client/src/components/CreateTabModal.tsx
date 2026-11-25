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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-slate-100">Nova Aba Criptografada</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="text-xs text-slate-400 mb-4">
          Uma chave exclusiva AES-256-GCM será gerada no seu navegador para esta aba. Nem o nome da
          aba fica visível para o servidor.
        </p>

        {error && (
          <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
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
                  ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-200'
                  : 'border-slate-700 bg-slate-950/60 text-slate-300 hover:border-slate-600'
              }`}
            >
              <FileText className="h-5 w-5 mb-2" />
              <div className="text-sm font-semibold">Documentos</div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                PDFs, imagens, recibos e notas pessoais
              </div>
            </button>

            <button
              type="button"
              onClick={() => setType('table')}
              className={`rounded-xl border p-3.5 text-left transition cursor-pointer ${
                type === 'table'
                  ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-200'
                  : 'border-slate-700 bg-slate-950/60 text-slate-300 hover:border-slate-600'
              }`}
            >
              <Table2 className="h-5 w-5 mb-2" />
              <div className="text-sm font-semibold">Tabela</div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                Dados estruturados, financeiro e totais
              </div>
            </button>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
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
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Descrição (opcional, também criptografada)
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Breve resumo do conteúdo desta aba"
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          {type === 'table' && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Modelo inicial de colunas
              </label>
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value as TableTemplate)}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
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
              className="rounded-xl border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 cursor-pointer"
            >
              {busy ? 'Gerando chave e criando...' : 'Criar Aba'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
