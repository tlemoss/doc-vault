import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  Columns3,
  Download,
  Lock,
  Plus,
  Search,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import { encryptJson } from '../crypto/engine';
import { decryptTableRow, defaultTableSchema } from '../crypto/vault';
import type {
  CellValue,
  ColumnType,
  DecryptedTab,
  DecryptedTableRow,
  TableColumn,
  TableSchema,
} from '../types';
import { formatCurrency, formatDate } from '../utils/format';

interface TableTabProps {
  tab: DecryptedTab;
  onSchemaUpdated: (tabId: string, nextSchema: TableSchema) => void;
  onQuotaChanged: (usedBytes: number) => void;
  onOpenShare: () => void;
  onDeleteTab: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'err') => void;
}

const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
  text: 'Texto',
  number: 'Número',
  currency: 'Moeda',
  date: 'Data',
  select: 'Categoria',
  checkbox: 'Checkbox',
};

function defaultCellValue(col: TableColumn): CellValue {
  if (col.type === 'checkbox') return false;
  if (col.type === 'number' || col.type === 'currency') return 0;
  if (col.type === 'date') return new Date().toISOString().slice(0, 10);
  if (col.type === 'select') return col.options?.[0] ?? '';
  return '';
}

export function TableTab({
  tab,
  onSchemaUpdated,
  onQuotaChanged,
  onOpenShare,
  onDeleteTab,
  onNotify,
}: TableTabProps) {
  const canEdit = tab.role === 'owner' || tab.role === 'editor';
  const isOwner = tab.role === 'owner';
  const schema = tab.schema ?? defaultTableSchema();

  const [rows, setRows] = useState<DecryptedTableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [sortBy, setSortBy] = useState<{ colId: string; dir: 'asc' | 'desc' } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Inline row editor modal (for adding or editing a row comfortably)
  const [rowModal, setRowModal] = useState<{
    id: string | null;
    values: Record<string, CellValue>;
  } | null>(null);
  const [savingRow, setSavingRow] = useState(false);

  // Column schema editor modal
  const [schemaModal, setSchemaModal] = useState<TableColumn[] | null>(null);
  const [savingSchema, setSavingSchema] = useState(false);

  const loadRows = useCallback(async () => {
    setLoading(true);
    try {
      const { rows: encRows } = await api.tables.listRows(tab.id);
      const decrypted = await Promise.all(
        encRows.map((r) => decryptTableRow(r, tab.tabKey))
      );
      setRows(decrypted);
      setSelectedIds(new Set());
    } catch (err: unknown) {
      onNotify(
        err instanceof Error ? err.message : 'Erro ao descriptografar registros.',
        'err'
      );
    } finally {
      setLoading(false);
    }
  }, [tab.id, tab.tabKey, onNotify]);

  useEffect(() => {
    void loadRows();
    setColumnFilters({});
    setSearch('');
    setSortBy(null);
  }, [loadRows]);

  function openNewRow() {
    const values: Record<string, CellValue> = {};
    for (const col of schema.columns) {
      values[col.id] = defaultCellValue(col);
    }
    setRowModal({ id: null, values });
  }

  async function handleSaveRow(e: React.FormEvent) {
    e.preventDefault();
    if (!rowModal) return;
    setSavingRow(true);
    try {
      const enc = await encryptJson(rowModal.values, tab.tabKey);
      if (!rowModal.id) {
        const res = await api.tables.createRow(tab.id, {
          encryptedData: enc.ciphertext,
          dataIv: enc.iv,
        });
        setRows((prev) => [
          ...prev,
          {
            id: res.row.id,
            tabId: tab.id,
            sortOrder: res.row.sortOrder,
            values: rowModal.values,
            createdAt: res.row.createdAt,
            updatedAt: res.row.updatedAt,
          },
        ]);
        onQuotaChanged(res.usedBytes);
      } else {
        const res = await api.tables.updateRow(tab.id, rowModal.id, {
          encryptedData: enc.ciphertext,
          dataIv: enc.iv,
        });
        setRows((prev) =>
          prev.map((r) =>
            r.id === rowModal.id
              ? { ...r, values: rowModal.values, updatedAt: res.updatedAt }
              : r
          )
        );
      }
      setRowModal(null);
    } catch (err: unknown) {
      onNotify(err instanceof Error ? err.message : 'Erro ao salvar registro.', 'err');
    } finally {
      setSavingRow(false);
    }
  }

  async function handleQuickToggleCheckbox(row: DecryptedTableRow, colId: string) {
    if (!canEdit) return;
    const nextValues = { ...row.values, [colId]: !Boolean(row.values[colId]) };
    try {
      const enc = await encryptJson(nextValues, tab.tabKey);
      const res = await api.tables.updateRow(tab.id, row.id, {
        encryptedData: enc.ciphertext,
        dataIv: enc.iv,
      });
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id ? { ...r, values: nextValues, updatedAt: res.updatedAt } : r
        )
      );
    } catch (err: unknown) {
      onNotify(err instanceof Error ? err.message : 'Erro ao atualizar célula.', 'err');
    }
  }

  async function handleDeleteRow(rowId: string) {
    try {
      await api.tables.deleteRow(tab.id, rowId);
      setRows((prev) => prev.filter((r) => r.id !== rowId));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(rowId);
        return next;
      });
    } catch (err: unknown) {
      onNotify(err instanceof Error ? err.message : 'Erro ao excluir linha.', 'err');
    }
  }

  async function handleBatchDelete() {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`Excluir ${selectedIds.size} registro(s) selecionado(s)?`)) return;
    try {
      const ids = Array.from(selectedIds);
      await api.tables.batchDeleteRows(tab.id, ids);
      setRows((prev) => prev.filter((r) => !selectedIds.has(r.id)));
      setSelectedIds(new Set());
      onNotify(`${ids.length} registro(s) excluído(s).`);
    } catch (err: unknown) {
      onNotify(err instanceof Error ? err.message : 'Erro ao excluir registros.', 'err');
    }
  }

  async function handleSaveSchema(e: React.FormEvent) {
    e.preventDefault();
    if (!schemaModal || schemaModal.length === 0) {
      onNotify('A tabela precisa ter pelo menos uma coluna.', 'err');
      return;
    }
    setSavingSchema(true);
    try {
      const cleaned: TableColumn[] = schemaModal.map((c) => ({
        ...c,
        name: c.name.trim() || 'Coluna',
        options:
          c.type === 'select'
            ? (c.options ?? []).map((o) => o.trim()).filter(Boolean)
            : undefined,
        currency: c.type === 'currency' ? c.currency || 'BRL' : undefined,
      }));
      const nextSchema: TableSchema = { columns: cleaned };
      const encSchema = await encryptJson(nextSchema, tab.tabKey);
      await api.tabs.update(tab.id, {
        encryptedSchema: encSchema.ciphertext,
        schemaIv: encSchema.iv,
      });
      onSchemaUpdated(tab.id, nextSchema);
      setSchemaModal(null);
      onNotify('Colunas atualizadas e criptografadas.');
    } catch (err: unknown) {
      onNotify(err instanceof Error ? err.message : 'Erro ao salvar colunas.', 'err');
    } finally {
      setSavingSchema(false);
    }
  }

  const filteredAndSortedRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      for (const [colId, filterVal] of Object.entries(columnFilters)) {
        if (!filterVal) continue;
        const val = row.values[colId];
        if (filterVal === '__true__' && val !== true) return false;
        if (filterVal === '__false__' && val === true) return false;
        if (
          filterVal !== '__true__' &&
          filterVal !== '__false__' &&
          String(val ?? '') !== filterVal
        ) {
          return false;
        }
      }
      if (!q) return true;
      return schema.columns.some((col) =>
        String(row.values[col.id] ?? '')
          .toLowerCase()
          .includes(q)
      );
    });

    if (!sortBy) return filtered;
    const col = schema.columns.find((c) => c.id === sortBy.colId);
    if (!col) return filtered;

    return [...filtered].sort((a, b) => {
      const va = a.values[col.id];
      const vb = b.values[col.id];
      let cmp = 0;
      if (col.type === 'number' || col.type === 'currency') {
        cmp = (Number(va) || 0) - (Number(vb) || 0);
      } else if (col.type === 'checkbox') {
        cmp = Number(Boolean(va)) - Number(Boolean(vb));
      } else {
        cmp = String(va ?? '').localeCompare(String(vb ?? ''), 'pt-BR');
      }
      return sortBy.dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, search, columnFilters, sortBy, schema.columns]);

  // Compute live summaries for numeric / currency columns
  const numericSummaries = useMemo(() => {
    const numCols = schema.columns.filter(
      (c) => c.type === 'currency' || c.type === 'number'
    );
    return numCols.map((col) => {
      const nums = filteredAndSortedRows
        .map((r) => Number(r.values[col.id]))
        .filter((n) => Number.isFinite(n));
      const sum = nums.reduce((acc, n) => acc + n, 0);
      const avg = nums.length > 0 ? sum / nums.length : 0;
      return { col, sum, avg, count: nums.length };
    });
  }, [schema.columns, filteredAndSortedRows]);

  function exportCsv() {
    const escape = (v: unknown) => {
      const s = String(v ?? '');
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const header = schema.columns.map((c) => escape(c.name)).join(',');
    const lines = filteredAndSortedRows.map((row) =>
      schema.columns
        .map((c) => {
          const val = row.values[c.id];
          if (c.type === 'checkbox') return val ? 'Sim' : 'Não';
          return escape(val ?? '');
        })
        .join(',')
    );
    const csv = '\uFEFF' + [header, ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${tab.meta.title.toLowerCase().replace(/\s+/g, '-')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function toggleSort(colId: string) {
    setSortBy((prev) => {
      if (!prev || prev.colId !== colId) return { colId, dir: 'asc' };
      if (prev.dir === 'asc') return { colId, dir: 'desc' };
      return null;
    });
  }

  const filterableColumns = schema.columns.filter(
    (c) => c.type === 'select' || c.type === 'checkbox'
  );

  return (
    <div className="flex-1 flex flex-col h-screen overflow-hidden">
      {/* Header */}
      <header className="px-6 py-4 border-b border-slate-800 bg-slate-900/50 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-slate-100 truncate">{tab.meta.title}</h1>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
              <Lock className="h-3 w-3" />
              AES-256 · v{tab.keyVersion}
            </span>
            {tab.role === 'viewer' && (
              <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">
                Somente leitura
              </span>
            )}
          </div>
          {tab.meta.description && (
            <p className="text-xs text-slate-400 mt-0.5 truncate">{tab.meta.description}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canEdit && (
            <>
              <button
                type="button"
                onClick={openNewRow}
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 transition cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                Novo Registro
              </button>
              <button
                type="button"
                onClick={() =>
                  setSchemaModal(schema.columns.map((c) => ({ ...c, options: [...(c.options ?? [])] })))
                }
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-100 hover:bg-slate-700 transition cursor-pointer"
              >
                <Columns3 className="h-4 w-4" />
                Colunas
              </button>
            </>
          )}
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 transition cursor-pointer"
          >
            <Download className="h-4 w-4" />
            CSV
          </button>
          <button
            type="button"
            onClick={onOpenShare}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 transition cursor-pointer"
          >
            <Share2 className="h-4 w-4" />
            Acesso ({tab.memberCount})
          </button>
          {isOwner && (
            <button
              type="button"
              onClick={onDeleteTab}
              title="Excluir aba"
              className="rounded-xl border border-slate-800 p-2 text-slate-400 hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-400 transition cursor-pointer"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      {/* Live Numeric/Financial Summary Bar */}
      <div className="px-6 py-3 border-b border-slate-800/70 bg-slate-900/30 flex flex-wrap items-center gap-3">
        <div className="rounded-xl border border-slate-800 bg-slate-900/80 px-3.5 py-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Registros</div>
          <div className="text-sm font-bold text-slate-100">
            {filteredAndSortedRows.length}
            {filteredAndSortedRows.length !== rows.length && (
              <span className="text-xs font-normal text-slate-500"> / {rows.length}</span>
            )}
          </div>
        </div>

        {numericSummaries.map(({ col, sum, avg }) => (
          <div
            key={col.id}
            className="rounded-xl border border-slate-800 bg-slate-900/80 px-3.5 py-2"
          >
            <div className="text-[10px] uppercase tracking-wider text-slate-500">
              Total · {col.name}
            </div>
            <div className="flex items-baseline gap-2">
              <span
                className={`text-sm font-bold ${
                  sum < 0 ? 'text-rose-400' : 'text-emerald-400'
                }`}
              >
                {col.type === 'currency'
                  ? formatCurrency(sum, col.currency)
                  : sum.toLocaleString('pt-BR')}
              </span>
              <span className="text-[11px] text-slate-500">
                média:{' '}
                {col.type === 'currency'
                  ? formatCurrency(avg, col.currency)
                  : avg.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Search & Column Filters */}
      <div className="px-6 py-3 border-b border-slate-800/70 bg-slate-950/40 flex flex-wrap items-center gap-2.5">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="h-4 w-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filtrar linhas localmente..."
            className="w-full rounded-xl border border-slate-800 bg-slate-900 pl-9 pr-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
          />
        </div>

        {filterableColumns.map((col) => (
          <select
            key={col.id}
            value={columnFilters[col.id] ?? ''}
            onChange={(e) =>
              setColumnFilters((prev) => ({ ...prev, [col.id]: e.target.value }))
            }
            className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
          >
            <option value="">{col.name}: Todos</option>
            {col.type === 'checkbox' ? (
              <>
                <option value="__true__">{col.name}: Sim</option>
                <option value="__false__">{col.name}: Não</option>
              </>
            ) : (
              (col.options ?? []).map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))
            )}
          </select>
        ))}

        {canEdit && selectedIds.size > 0 && (
          <button
            type="button"
            onClick={handleBatchDelete}
            className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20 cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Excluir ({selectedIds.size})
          </button>
        )}
      </div>

      {/* Data Table */}
      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className="py-16 text-center text-sm text-slate-400">
            Descriptografando registros da tabela...
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/90 text-slate-400">
                  {canEdit && (
                    <th className="w-10 px-3 py-3">
                      <input
                        type="checkbox"
                        checked={
                          filteredAndSortedRows.length > 0 &&
                          selectedIds.size === filteredAndSortedRows.length
                        }
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedIds(new Set(filteredAndSortedRows.map((r) => r.id)));
                          } else {
                            setSelectedIds(new Set());
                          }
                        }}
                        className="rounded border-slate-600 bg-slate-800 text-emerald-500"
                      />
                    </th>
                  )}
                  {schema.columns.map((col) => (
                    <th
                      key={col.id}
                      onClick={() => toggleSort(col.id)}
                      className="px-4 py-3 font-semibold uppercase tracking-wider text-[11px] cursor-pointer hover:text-slate-200 select-none whitespace-nowrap"
                    >
                      <span className="inline-flex items-center gap-1">
                        {col.name}
                        {sortBy?.colId === col.id ? (
                          sortBy.dir === 'asc' ? (
                            <ArrowUp className="h-3 w-3 text-emerald-400" />
                          ) : (
                            <ArrowDown className="h-3 w-3 text-emerald-400" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-30" />
                        )}
                      </span>
                    </th>
                  ))}
                  {canEdit && <th className="w-20 px-3 py-3 text-right">Ações</th>}
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-800/70">
                {filteredAndSortedRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={schema.columns.length + (canEdit ? 2 : 0)}
                      className="px-6 py-12 text-center text-slate-500"
                    >
                      {rows.length === 0
                        ? 'Nenhum registro ainda. Clique em "Novo Registro" para lançar dados criptografados.'
                        : 'Nenhum registro corresponde aos filtros aplicados.'}
                    </td>
                  </tr>
                ) : (
                  filteredAndSortedRows.map((row) => (
                    <tr
                      key={row.id}
                      className="hover:bg-slate-800/40 transition group"
                    >
                      {canEdit && (
                        <td className="px-3 py-2.5">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(row.id)}
                            onChange={(e) => {
                              setSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(row.id);
                                else next.delete(row.id);
                                return next;
                              });
                            }}
                            className="rounded border-slate-600 bg-slate-800 text-emerald-500"
                          />
                        </td>
                      )}

                      {schema.columns.map((col) => {
                        const val = row.values[col.id];
                        return (
                          <td
                            key={col.id}
                            onClick={() => {
                              if (canEdit && col.type !== 'checkbox') {
                                setRowModal({ id: row.id, values: { ...row.values } });
                              }
                            }}
                            className={`px-4 py-2.5 whitespace-nowrap ${
                              canEdit && col.type !== 'checkbox' ? 'cursor-pointer' : ''
                            }`}
                          >
                            {col.type === 'checkbox' ? (
                              <button
                                type="button"
                                disabled={!canEdit}
                                onClick={() => handleQuickToggleCheckbox(row, col.id)}
                                className={`inline-flex h-5 w-5 items-center justify-center rounded-md border transition cursor-pointer ${
                                  val
                                    ? 'border-emerald-500 bg-emerald-500/20 text-emerald-400'
                                    : 'border-slate-700 bg-slate-900 text-transparent'
                                }`}
                              >
                                <Check className="h-3.5 w-3.5" />
                              </button>
                            ) : col.type === 'currency' ? (
                              <span
                                className={`font-mono font-medium ${
                                  Number(val) < 0 ? 'text-rose-400' : 'text-emerald-300'
                                }`}
                              >
                                {formatCurrency(Number(val) || 0, col.currency)}
                              </span>
                            ) : col.type === 'number' ? (
                              <span className="font-mono text-slate-200">
                                {(Number(val) || 0).toLocaleString('pt-BR')}
                              </span>
                            ) : col.type === 'date' ? (
                              <span className="text-slate-300">
                                {formatDate(String(val ?? ''))}
                              </span>
                            ) : col.type === 'select' ? (
                              val ? (
                                <span className="inline-flex rounded-lg bg-slate-800 border border-slate-700 px-2 py-0.5 text-[11px] text-slate-200">
                                  {String(val)}
                                </span>
                              ) : (
                                <span className="text-slate-600">—</span>
                              )
                            ) : (
                              <span className="text-slate-200">
                                {String(val ?? '') || <span className="text-slate-600">—</span>}
                              </span>
                            )}
                          </td>
                        );
                      })}

                      {canEdit && (
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => handleDeleteRow(row.id)}
                            title="Excluir linha"
                            className="rounded-lg p-1 text-slate-500 hover:bg-slate-800 hover:text-rose-400 transition cursor-pointer"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Row Create/Edit Modal */}
      {rowModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-slate-100">
                {rowModal.id ? 'Editar Registro' : 'Novo Registro Criptografado'}
              </h2>
              <button
                type="button"
                onClick={() => setRowModal(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSaveRow} className="space-y-3.5">
              {schema.columns.map((col) => {
                const val = rowModal.values[col.id];
                return (
                  <div key={col.id}>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      {col.name}{' '}
                      <span className="text-[10px] text-slate-500">
                        ({COLUMN_TYPE_LABELS[col.type]}
                        {col.type === 'currency' ? ` ${col.currency ?? 'BRL'}` : ''})
                      </span>
                    </label>

                    {col.type === 'checkbox' ? (
                      <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(val)}
                          onChange={(e) =>
                            setRowModal({
                              ...rowModal,
                              values: { ...rowModal.values, [col.id]: e.target.checked },
                            })
                          }
                          className="rounded border-slate-600 bg-slate-800 text-emerald-500"
                        />
                        Marcado
                      </label>
                    ) : col.type === 'select' ? (
                      <select
                        value={String(val ?? '')}
                        onChange={(e) =>
                          setRowModal({
                            ...rowModal,
                            values: { ...rowModal.values, [col.id]: e.target.value },
                          })
                        }
                        className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
                      >
                        <option value="">— Selecione —</option>
                        {(col.options ?? []).map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : col.type === 'number' || col.type === 'currency' ? (
                      <input
                        type="number"
                        step="any"
                        value={val === null || val === undefined ? '' : String(val)}
                        onChange={(e) =>
                          setRowModal({
                            ...rowModal,
                            values: {
                              ...rowModal.values,
                              [col.id]: e.target.value === '' ? 0 : Number(e.target.value),
                            },
                          })
                        }
                        className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-mono text-slate-100 focus:border-emerald-500 focus:outline-none"
                      />
                    ) : col.type === 'date' ? (
                      <input
                        type="date"
                        value={String(val ?? '')}
                        onChange={(e) =>
                          setRowModal({
                            ...rowModal,
                            values: { ...rowModal.values, [col.id]: e.target.value },
                          })
                        }
                        className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
                      />
                    ) : (
                      <input
                        type="text"
                        value={String(val ?? '')}
                        onChange={(e) =>
                          setRowModal({
                            ...rowModal,
                            values: { ...rowModal.values, [col.id]: e.target.value },
                          })
                        }
                        className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
                      />
                    )}
                  </div>
                );
              })}

              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setRowModal(null)}
                  className="rounded-xl border border-slate-700 px-4 py-2 text-xs text-slate-300 hover:bg-slate-800 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={savingRow}
                  className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 cursor-pointer"
                >
                  {savingRow ? 'Criptografando...' : 'Salvar Registro'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Column Schema Editor Modal */}
      {schemaModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-100">
                  Configurar Colunas da Tabela
                </h2>
                <p className="text-xs text-slate-400">
                  O esquema de colunas também é armazenado criptografado no banco.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSchemaModal(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSaveSchema} className="flex-1 overflow-y-auto space-y-3 pr-1">
              {schemaModal.map((col, idx) => (
                <div
                  key={col.id}
                  className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 space-y-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={col.name}
                      onChange={(e) => {
                        const next = [...schemaModal];
                        next[idx] = { ...col, name: e.target.value };
                        setSchemaModal(next);
                      }}
                      placeholder="Nome da coluna"
                      className="flex-1 min-w-[140px] rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
                    />
                    <select
                      value={col.type}
                      onChange={(e) => {
                        const nextType = e.target.value as ColumnType;
                        const next = [...schemaModal];
                        next[idx] = {
                          ...col,
                          type: nextType,
                          currency: nextType === 'currency' ? col.currency || 'BRL' : undefined,
                          options:
                            nextType === 'select'
                              ? col.options?.length
                                ? col.options
                                : ['Opção 1', 'Opção 2']
                              : undefined,
                        };
                        setSchemaModal(next);
                      }}
                      className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
                    >
                      {Object.entries(COLUMN_TYPE_LABELS).map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </select>

                    {col.type === 'currency' && (
                      <select
                        value={col.currency ?? 'BRL'}
                        onChange={(e) => {
                          const next = [...schemaModal];
                          next[idx] = { ...col, currency: e.target.value };
                          setSchemaModal(next);
                        }}
                        className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
                      >
                        <option value="BRL">BRL (R$)</option>
                        <option value="USD">USD ($)</option>
                        <option value="EUR">EUR (€)</option>
                      </select>
                    )}

                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => {
                        const next = [...schemaModal];
                        [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                        setSchemaModal(next);
                      }}
                      className="rounded-lg border border-slate-800 p-1.5 text-slate-400 hover:bg-slate-800 disabled:opacity-30 cursor-pointer"
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === schemaModal.length - 1}
                      onClick={() => {
                        const next = [...schemaModal];
                        [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
                        setSchemaModal(next);
                      }}
                      className="rounded-lg border border-slate-800 p-1.5 text-slate-400 hover:bg-slate-800 disabled:opacity-30 cursor-pointer"
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setSchemaModal(schemaModal.filter((c) => c.id !== col.id))
                      }
                      className="rounded-lg border border-slate-800 p-1.5 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {col.type === 'select' && (
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Opções da categoria (separadas por vírgula)
                      </label>
                      <input
                        type="text"
                        value={(col.options ?? []).join(', ')}
                        onChange={(e) => {
                          const next = [...schemaModal];
                          next[idx] = {
                            ...col,
                            options: e.target.value.split(','),
                          };
                          setSchemaModal(next);
                        }}
                        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
                      />
                    </div>
                  )}
                </div>
              ))}

              <button
                type="button"
                onClick={() =>
                  setSchemaModal([
                    ...schemaModal,
                    { id: crypto.randomUUID(), name: 'Nova Coluna', type: 'text' },
                  ])
                }
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-700 py-2.5 text-xs font-medium text-slate-300 hover:border-emerald-500/50 hover:text-emerald-300 transition cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                Adicionar Coluna
              </button>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setSchemaModal(null)}
                  className="rounded-xl border border-slate-700 px-4 py-2 text-xs text-slate-300 hover:bg-slate-800 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={savingSchema}
                  className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 cursor-pointer"
                >
                  {savingSchema ? 'Salvando...' : 'Salvar Colunas'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
