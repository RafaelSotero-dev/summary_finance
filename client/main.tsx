import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const neutralConfirmation = "Se os dados informados estiverem cadastrados, você receberá um link de acesso por e-mail.";
const navigation = [
  ["/", "Visão Consolidada"],
  ["/transactions", "Transactions"],
  ["/transaction-categories", "Transaction Categories"],
  ["/spending-analysis", "Spending Analysis"],
  ["/open-finance-connections", "Open Finance Connections"],
] as const;

type FinancialAccount = { name: string; balance: number; currency: string; includedInTotals: boolean };
type CreditCard = { id: string; name: string; kind: string; currency: string; includedInTotals?: boolean; statement?: { amountDue: number; dueDate?: string } };
type FinancialInstitution = {
  name: string; dataFreshness: string; dataAvailability?: string[]; consentStatus: "active" | "reconnection-required" | "disconnected";
  financialAccounts: FinancialAccount[]; institutionCardStatement?: { amountDue: number; currency: string; dueDate?: string; creditCards: CreditCard[] };
};
type Overview = { consolidatedView: { financialInstitutions: FinancialInstitution[] } };
type Summary = { financialAccountBalance: number; creditCardStatementBalance: number; netBalance: number };
type Report = {
  period: { startDate?: string; endDate?: string };
  totals: { income: number; expenses: number; net: number };
  temporalSeries: { date: string; income: number; expenses: number; net: number }[];
  expenseDistribution: { category: { id: string; name: string }; amount: number }[];
};
type SpendingAnalysis = {
  totals: { income: number; expenses: number; net: number };
  uncategorizedTransactions: number;
  historicalComparison?: { granularity: string; categories: { category: { id: string; name: string }; periods: { period: string; expenses: number }[] }[] };
};
type ReportFilterValues = Record<"period" | "startDate" | "endDate" | "financialInstitution" | "financialAccount" | "creditCard" | "categoryId" | "type", string>;

function reportFiltersFromUrl(): ReportFilterValues {
  const params = new URLSearchParams(window.location.search);
  return {
    period: params.get("period") ?? "this-month",
    startDate: params.get("startDate") ?? "", endDate: params.get("endDate") ?? "",
    financialInstitution: params.get("financialInstitution") ?? "", financialAccount: params.get("financialAccount") ?? "",
    creditCard: params.get("creditCard") ?? "", categoryId: params.get("categoryId") ?? "", type: params.get("type") ?? "",
  };
}

function reportQuery(filters: ReportFilterValues, additional: Record<string, string> = {}) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries({ ...filters, ...additional })) if (value) params.set(name, value);
  return params.toString();
}

function ReportFilters({ filters, setFilters }: { filters: ReportFilterValues; setFilters: (filters: ReportFilterValues) => void }) {
  function change(name: keyof ReportFilterValues, value: string) {
    const next = { ...filters, [name]: value };
    if (name === "period" && value !== "custom") { next.startDate = ""; next.endDate = ""; }
    setFilters(next);
  }
  return <form className="report-filters" onSubmit={(event) => event.preventDefault()} aria-label="Filtros do relatório">
    <label>Período<select aria-label="Período" value={filters.period} onChange={(event) => change("period", event.target.value)}>
      <option value="this-month">Mês atual</option><option value="today">Hoje</option><option value="this-week">Esta semana</option><option value="last-month">Mês anterior</option><option value="this-year">Este ano</option><option value="custom">Intervalo personalizado</option>
    </select></label>
    {filters.period === "custom" && <><label>Data inicial<input aria-label="Data inicial" type="date" value={filters.startDate} onChange={(event) => change("startDate", event.target.value)} /></label><label>Data final<input aria-label="Data final" type="date" value={filters.endDate} onChange={(event) => change("endDate", event.target.value)} /></label></>}
    <label>Financial Institution<input aria-label="Financial Institution" value={filters.financialInstitution} onChange={(event) => change("financialInstitution", event.target.value)} /></label>
    <label>Financial Account<input aria-label="Financial Account" value={filters.financialAccount} onChange={(event) => change("financialAccount", event.target.value)} /></label>
    <label>Credit Card<input aria-label="Credit Card" value={filters.creditCard} onChange={(event) => change("creditCard", event.target.value)} /></label>
    <label>Transaction Category<input aria-label="Transaction Category" value={filters.categoryId} onChange={(event) => change("categoryId", event.target.value)} /></label>
    <label>Tipo<select aria-label="Tipo" value={filters.type} onChange={(event) => change("type", event.target.value)}><option value="">Todos</option><option value="income">Receitas</option><option value="expense">Despesas</option></select></label>
  </form>;
}

function AccessibleReport({ report }: { report: Report }) {
  return <section className="report-results" aria-labelledby="report-title">
    <h2 id="report-title">Relatórios do período</h2>
    <dl className="totals" aria-label="Totais do relatório"><div><dt>Receitas</dt><dd>{formatCurrency(report.totals.income)}</dd></div><div><dt>Despesas</dt><dd>{formatCurrency(report.totals.expenses)}</dd></div><div><dt>Resultado</dt><dd>{formatCurrency(report.totals.net)}</dd></div></dl>
    <section aria-labelledby="temporal-series-title"><h3 id="temporal-series-title">Série temporal</h3><table><thead><tr><th>Data</th><th>Receitas</th><th>Despesas</th><th>Resultado</th></tr></thead><tbody>{report.temporalSeries.map((point) => <tr key={point.date}><th scope="row">{point.date}</th><td>{formatCurrency(point.income)}</td><td>{formatCurrency(point.expenses)}</td><td>{formatCurrency(point.net)}</td></tr>)}</tbody></table>{!report.temporalSeries.length && <p>Nenhuma Transaction confirmada no período.</p>}</section>
    <section aria-labelledby="expense-distribution-title"><h3 id="expense-distribution-title">Distribuição de despesas</h3><table><thead><tr><th>Transaction Category</th><th>Despesas</th></tr></thead><tbody>{report.expenseDistribution.map(({ category, amount }) => <tr key={category.id}><th scope="row">{category.name}</th><td>{formatCurrency(amount)}</td></tr>)}</tbody></table>{!report.expenseDistribution.length && <p>Nenhuma despesa categorizada no período.</p>}</section>
  </section>;
}
type Connection = {
  financialInstitution: { name: string; dataFreshness: string };
  dataAvailability: string[];
  consentStatus: "active" | "reconnection-required" | "disconnected";
  transactionsLastSynchronizedAt: string | null;
};
type ConnectionList = { openFinanceConnections: Connection[] };

function normalizeCpf(value: string) { return value.replace(/\D/g, ""); }
function formatCpf(value: string) {
  return normalizeCpf(value).slice(0, 11).replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2");
}
function formatCurrency(value: number, currency = "BRL") {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value);
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function LoginPage() {
  const [cpf, setCpf] = useState(""); const [email, setEmail] = useState(""); const [sending, setSending] = useState(false);
  const [confirmation, setConfirmation] = useState(""); const [error, setError] = useState(() => new URLSearchParams(window.location.search).get("error") === "invalid-link" ? "Este link de acesso é inválido ou expirou. Solicite um novo link." : "");
  async function requestMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedCpf = normalizeCpf(cpf);
    if (normalizedCpf.length !== 11) return setError("Informe um CPF com 11 dígitos.");
    if (!email.trim() || !email.includes("@")) return setError("Informe um e-mail válido.");
    setSending(true); setError("");
    try {
      const response = await fetch("/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cpf: normalizedCpf, email: email.trim(), returnTo: new URLSearchParams(window.location.search).get("next") ?? "/" }) });
      if (!response.ok) throw new Error("Não foi possível solicitar o link agora.");
      setConfirmation(neutralConfirmation);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Não foi possível solicitar o link agora."); }
    finally { setSending(false); }
  }
  return <main className="login-page"><section className="login-card" aria-labelledby="login-title">
    <p className="eyebrow">Personal Finance Dashboard</p><h1 id="login-title">Entrar</h1><p className="description">Informe seus dados para receber um link de acesso.</p>
    <form onSubmit={requestMagicLink} noValidate>
      <label htmlFor="cpf">CPF</label><input id="cpf" name="cpf" inputMode="numeric" autoComplete="username" value={cpf} onChange={(event) => setCpf(formatCpf(event.target.value))} aria-describedby={error ? "login-error" : undefined} />
      <label htmlFor="email">E-mail</label><input id="email" name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} aria-describedby={error ? "login-error" : undefined} />
      {error && <p id="login-error" className="message error" role="alert">{error}</p>}{confirmation && <p className="message confirmation" role="status">{confirmation}</p>}
      <button type="submit" disabled={sending}>{sending ? "Enviando…" : "Enviar link de acesso"}</button>
    </form>
  </section></main>;
}

type TransactionCategory = { id: string; name: string; parentCategoryId: string | null; archived: boolean };

function CategoriesPage() {
  const [categories, setCategories] = useState<TransactionCategory[]>([]);
  const [name, setName] = useState("");
  const [parentCategoryId, setParentCategoryId] = useState("");
  const [editing, setEditing] = useState<TransactionCategory | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [confirmingArchive, setConfirmingArchive] = useState<string | null>(null);

  const roots = categories.filter((category) => category.parentCategoryId === null);
  const activeRoots = roots.filter((category) => !category.archived);

  async function request(path: string, options?: RequestInit) {
    const response = await fetch(path, { headers: { "content-type": "application/json", ...(options?.headers ?? {}) }, ...options });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error ?? "Não foi possível salvar a categoria.");
    }
    return response.status === 204 ? undefined : response.json();
  }

  async function loadCategories() {
    try {
      const payload = await request("/api/categories") as { categories: TransactionCategory[] };
      setCategories(payload.categories);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar as categorias.");
    }
  }

  useEffect(() => { void loadCategories(); }, []);

  async function createCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return setError("Informe o nome da categoria.");
    setError("");
    try {
      await request("/api/categories", { method: "POST", body: JSON.stringify({ name, parentCategoryId: parentCategoryId || null }) });
      setName(""); setParentCategoryId(""); setStatus("Categoria criada."); await loadCategories();
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Não foi possível criar a categoria."); }
  }

  async function saveCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    if (!editing.name.trim()) return setError("Informe o nome da categoria.");
    setError("");
    try {
      await request(`/api/categories/${editing.id}`, { method: "PATCH", body: JSON.stringify({ name: editing.name, parentCategoryId: editing.parentCategoryId }) });
      setEditing(null); setStatus("Categoria atualizada."); await loadCategories();
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Não foi possível atualizar a categoria."); }
  }

  async function archiveCategory(category: TransactionCategory) {
    setError("");
    try {
      await request(`/api/categories/${category.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
      setConfirmingArchive(null); setStatus("Categoria arquivada."); await loadCategories();
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Não foi possível arquivar a categoria."); }
  }

  return <section className="categories-page" aria-labelledby="categories-title">
    <h1 id="categories-title">Categorias de transação</h1>
    <p className="description">Organize suas Transaction Categories em uma Category Hierarchy de até dois níveis.</p>
    {error && <p className="message error" role="alert">{error}</p>}
    {status && <p className="message confirmation" role="status">{status}</p>}
    <form className="category-form" onSubmit={createCategory} noValidate>
      <h2>Criar categoria</h2>
      <label htmlFor="category-name">Nome da categoria</label>
      <input id="category-name" value={name} onChange={(event) => setName(event.target.value)} />
      <label htmlFor="category-parent">Categoria pai <span className="optional">(opcional)</span></label>
      <select id="category-parent" value={parentCategoryId} onChange={(event) => setParentCategoryId(event.target.value)}>
        <option value="">Sem categoria pai</option>
        {activeRoots.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select>
      <button type="submit">Criar categoria</button>
    </form>
    {editing && <form className="category-form" onSubmit={saveCategory} noValidate>
      <h2>Editar categoria</h2>
      <label htmlFor="rename-category">Renomear categoria</label>
      <input id="rename-category" value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
      <label htmlFor="move-category">Mover para categoria pai</label>
      <select id="move-category" value={editing.parentCategoryId ?? ""} onChange={(event) => setEditing({ ...editing, parentCategoryId: event.target.value || null })}>
        <option value="">Sem categoria pai</option>
        {activeRoots.filter((category) => category.id !== editing.id).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select>
      <button type="submit">Salvar categoria</button>
      <button className="secondary" type="button" onClick={() => setEditing(null)}>Cancelar</button>
    </form>}
    <h2>Suas categorias</h2>
    <ul className="category-list" aria-label="Categorias de transação">
      {roots.map((category) => <li key={category.id}>
        <CategoryRow category={category} onEdit={setEditing} onArchive={setConfirmingArchive} confirmingArchive={confirmingArchive === category.id} onConfirmArchive={archiveCategory} />
        <ul>{categories.filter((child) => child.parentCategoryId === category.id).map((child) =>
          <li key={child.id}><CategoryRow category={child} onEdit={setEditing} onArchive={setConfirmingArchive} confirmingArchive={confirmingArchive === child.id} onConfirmArchive={archiveCategory} /></li>,
        )}</ul>
      </li>)}
      {roots.length === 0 && <li>Nenhuma categoria criada.</li>}
    </ul>
  </section>;
}

function CategoryRow({ category, onEdit, onArchive, confirmingArchive, onConfirmArchive }: { category: TransactionCategory; onEdit: (category: TransactionCategory) => void; onArchive: (id: string | null) => void; confirmingArchive: boolean; onConfirmArchive: (category: TransactionCategory) => void }) {
  return <div className="category-row">
    <span>{category.name}</span>{category.archived && <span className="archived">Arquivada</span>}
    {!category.archived && <><button className="secondary" type="button" onClick={() => onEdit(category)} aria-label={`Editar ${category.name}`}>Editar</button>
      {confirmingArchive ? <button type="button" onClick={() => void onConfirmArchive(category)}>Confirmar arquivamento</button> : <button className="secondary" type="button" onClick={() => onArchive(category.id)} aria-label={`Arquivar ${category.name}`}>Arquivar</button>}</>}
  </div>;
}

function useReportFilters() {
  const [filters, setFiltersState] = useState(reportFiltersFromUrl);
  function setFilters(next: ReportFilterValues) {
    setFiltersState(next);
    const query = reportQuery(next);
    history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }
  return [filters, setFilters] as const;
}

function ConsolidatedReports() {
  const [filters, setFilters] = useReportFilters();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setReport(null); setError("");
    if (filters.period === "custom" && (!filters.startDate || !filters.endDate)) return () => controller.abort();
    fetch(`/api/dashboard?${reportQuery(filters)}`, { signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("Não foi possível carregar os relatórios."); return response.json() as Promise<{ report: Report }>; })
      .then((payload) => setReport(payload.report))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Não foi possível carregar os relatórios."); });
    return () => controller.abort();
  }, [filters]);
  const needsCustomRange = filters.period === "custom" && (!filters.startDate || !filters.endDate);
  return <section className="reports-panel" aria-labelledby="reports-panel-title"><h2 id="reports-panel-title">Relatórios</h2><ReportFilters filters={filters} setFilters={setFilters} />{needsCustomRange ? <p role="status">Informe as duas datas do intervalo personalizado.</p> : error ? <p role="alert" className="message error">{error}</p> : report ? <AccessibleReport report={report} /> : <p role="status">Carregando relatórios…</p>}</section>;
}

function SpendingAnalysisPage() {
  const [filters, setFilters] = useReportFilters();
  const [granularity, setGranularity] = useState(() => new URLSearchParams(window.location.search).get("granularity") ?? "month");
  const [equivalentPeriod, setEquivalentPeriod] = useState(() => new URLSearchParams(window.location.search).get("equivalentPeriod") === "true");
  const [analysis, setAnalysis] = useState<SpendingAnalysis | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const params = { granularity, equivalentPeriod: equivalentPeriod ? "true" : "" };
    const query = reportQuery(filters, params);
    history.replaceState(null, "", `/spending-analysis?${query}`);
    setAnalysis(null); setError("");
    if (filters.period === "custom" && (!filters.startDate || !filters.endDate)) return () => controller.abort();
    fetch(`/api/spending-analysis?${query}`, { signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("Não foi possível carregar a Spending Analysis."); return response.json() as Promise<SpendingAnalysis>; })
      .then(setAnalysis).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Não foi possível carregar a Spending Analysis."); });
    return () => controller.abort();
  }, [filters, granularity, equivalentPeriod]);
  const needsCustomRange = filters.period === "custom" && (!filters.startDate || !filters.endDate);
  return <section className="spending-analysis" aria-labelledby="spending-analysis-title"><h1 id="spending-analysis-title">Spending Analysis</h1><p className="description">Compare despesas históricas por Transaction Category. Pending Transactions, Internal Transfers e Card Statement Settlements não entram nas despesas; Refunds as compensam.</p><ReportFilters filters={filters} setFilters={setFilters} />
    <fieldset className="comparison-controls"><legend>Comparação</legend><label>Granularidade<select aria-label="Granularidade" value={granularity} onChange={(event) => setGranularity(event.target.value)}><option value="day">Dia</option><option value="month">Mês</option><option value="year">Ano</option></select></label><label><input type="checkbox" checked={equivalentPeriod} onChange={(event) => setEquivalentPeriod(event.target.checked)} /> Comparar períodos equivalentes</label></fieldset>
    {needsCustomRange ? <p role="status">Informe as duas datas do intervalo personalizado.</p> : error ? <p role="alert" className="message error">{error}</p> : !analysis ? <p role="status">Carregando Spending Analysis…</p> : <><dl className="totals" aria-label="Totais da Spending Analysis"><div><dt>Receitas</dt><dd>{formatCurrency(analysis.totals.income)}</dd></div><div><dt>Despesas</dt><dd>{formatCurrency(analysis.totals.expenses)}</dd></div><div><dt>Transactions sem categoria</dt><dd>{analysis.uncategorizedTransactions}</dd></div></dl><section aria-labelledby="comparison-results"><h2 id="comparison-results">Comparação histórica</h2>{analysis.historicalComparison?.categories.map(({ category, periods }) => <table key={category.id}><caption>{category.name}</caption><thead><tr><th>Período</th><th>Despesas</th></tr></thead><tbody>{periods.map(({ period, expenses }) => <tr key={period}><th scope="row">{period}</th><td>{formatCurrency(expenses)}</td></tr>)}</tbody></table>)}{!analysis.historicalComparison?.categories.length && <p>Nenhuma despesa categorizada para comparar.</p>}</section></>}
  </section>;
}


type Transaction = { id: string; date: string; description: string; merchant: string; amount: number; currency: string; financialInstitution: string; pending: boolean; categoryId?: string | null; classification?: "standard" | "internal-transfer" | "refund"; suggestedMerchant?: string; suggestedCategoryId?: string };
type TransactionPage = { transactions: Transaction[]; pendingTransactions: Transaction[]; nextCursor?: string };

function TransactionsPage() {
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search));
  const [result, setResult] = useState<TransactionPage | null>(null);
  const [error, setError] = useState("");
  const [categories, setCategories] = useState<TransactionCategory[]>([]);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const queryString = query.toString();
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setError("");
    fetch(`/api/transactions?${queryString}`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error ?? "Não foi possível carregar as Transactions.");
      setResult(await response.json() as TransactionPage);
    }).catch((requestError: unknown) => { if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : "Não foi possível carregar as Transactions."); });
    return () => controller.abort();
  }, [queryString, reload]);
  useEffect(() => { fetch("/api/categories").then((response) => response.ok ? response.json() as Promise<{ categories: TransactionCategory[] }> : { categories: [] }).then((payload) => setCategories(payload.categories)); }, []);
  function apply(values: URLSearchParams) {
    values.set("limit", "50");
    values.delete("cursor");
    history.pushState(null, "", `/transactions?${values}`);
    setQuery(values);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new URLSearchParams();
    new FormData(event.currentTarget).forEach((value, key) => { if (typeof value === "string" && value) values.set(key, value); });
    apply(values);
  }
  function nextPage() {
    if (!result?.nextCursor) return;
    const values = new URLSearchParams(query); values.set("cursor", result.nextCursor);
    history.pushState(null, "", `/transactions?${values}`); setQuery(values);
  }
  function previousPage() {
    const values = new URLSearchParams(query); values.delete("cursor");
    history.pushState(null, "", `/transactions?${values}`); setQuery(values);
  }
  async function saveInterpretation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const values = new FormData(event.currentTarget);
    setSaving(true); setError("");
    try {
      const response = await fetch(`/api/transactions/${encodeURIComponent(editing.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ merchant: values.get("merchant"), categoryId: values.get("categoryId") || null, classification: values.get("classification") }) });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Não foi possível salvar a interpretação.");
      setEditing(null); setReload((value) => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível salvar a interpretação."); }
    finally { setSaving(false); }
  }
  const rows = (transactions: Transaction[], empty: string) => transactions.length
    ? <ul className="transaction-list">{transactions.map((transaction) => <li key={transaction.id}><time dateTime={transaction.date}>{new Intl.DateTimeFormat("pt-BR").format(new Date(`${transaction.date}T00:00:00Z`))}</time><span><strong>{transaction.merchant}</strong><small>{transaction.financialInstitution}</small></span><strong>{formatCurrency(transaction.amount, transaction.currency)}</strong><button className="secondary" type="button" onClick={() => setEditing(transaction)}>Editar interpretação</button></li>)}</ul>
    : <p>{empty}</p>;
  return <section className="transactions-page" aria-labelledby="transactions-title">
    <div className="page-title"><p className="eyebrow">Histórico financeiro</p><h1 id="transactions-title">Transactions</h1></div>
    <form className="transaction-filters" onSubmit={submit}>
      <label htmlFor="transaction-search">Busca</label><input id="transaction-search" name="search" defaultValue={query.get("search") ?? ""} />
      <label htmlFor="transaction-start-date">Data inicial</label><input id="transaction-start-date" name="startDate" type="date" defaultValue={query.get("startDate") ?? ""} />
      <label htmlFor="transaction-end-date">Data final</label><input id="transaction-end-date" name="endDate" type="date" defaultValue={query.get("endDate") ?? ""} />
      <label htmlFor="transaction-institution">Financial Institution</label><input id="transaction-institution" name="financialInstitution" defaultValue={query.get("financialInstitution") ?? ""} />
      <label htmlFor="transaction-type">Tipo</label><select id="transaction-type" name="type" defaultValue={query.get("type") ?? ""}><option value="">Todos</option><option value="income">Receitas</option><option value="expense">Despesas</option></select>
      <button type="submit">Aplicar filtros</button>
      <a className="button-link secondary" href={`/api/transactions/export?${queryString}`}>Exportar CSV</a>
    </form>
    {error && <section className="state-card" role="alert"><h2>Não foi possível carregar as Transactions</h2><p>{error}</p><button onClick={() => setReload((value) => value + 1)}>Tentar novamente</button></section>}
    {!error && !result && <section className="state-card" role="status"><h2>Carregando Transactions</h2></section>}
    {result && <><section className="transaction-section" aria-labelledby="confirmed-transactions"><h2 id="confirmed-transactions">Confirmadas</h2>{rows(result.transactions, "Nenhuma Transaction confirmada corresponde aos filtros.")}</section>
      <section className="transaction-section" aria-labelledby="pending-transactions"><h2 id="pending-transactions">Pendentes</h2>{rows(result.pendingTransactions, "Nenhuma Pending Transaction corresponde aos filtros.")}</section>
      <nav className="transaction-pagination" aria-label="Paginação de Transactions"><button className="secondary" type="button" disabled={!query.get("cursor")} onClick={previousPage}>Página anterior</button><button type="button" disabled={!result.nextCursor} onClick={nextPage}>Próxima página</button></nav>
    </>}
    {editing && <section className="state-card" aria-labelledby="interpretation-title"><h2 id="interpretation-title">Editar interpretação</h2><p>Standard entra normalmente nas análises; Internal Transfer é excluída; Refund compensa despesas. Ao corrigir Merchant e Transaction Category, uma Categorization Rule será criada ou atualizada para a descrição de origem.</p>
      <form onSubmit={saveInterpretation}><label>Merchant<input name="merchant" defaultValue={editing.merchant} required /></label><label>Transaction Category<select name="categoryId" defaultValue={editing.categoryId ?? editing.suggestedCategoryId ?? ""}><option value="">Sem categoria</option>{categories.filter((category) => !category.archived).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>Classificação<select name="classification" defaultValue={editing.classification ?? "standard"}><option value="standard">Standard</option><option value="internal-transfer">Internal Transfer</option><option value="refund">Refund</option></select></label><button disabled={saving} type="submit">{saving ? "Salvando…" : "Salvar interpretação"}</button><button className="secondary" type="button" onClick={() => setEditing(null)}>Cancelar</button></form>
    </section>}
  </section>;
}


function ConsolidatedView() {
  const [overview, setOverview] = useState<Overview | null>(null); const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState(""); const [retry, setRetry] = useState(0); const [updating, setUpdating] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setOverview(null); setSummary(null); setError("");
    Promise.all([fetch("/api/overview", { signal: controller.signal }), fetch("/api/consolidated-view/summary", { signal: controller.signal })])
      .then(async ([overviewResponse, summaryResponse]) => {
        if (!overviewResponse.ok || !summaryResponse.ok) throw new Error("Não foi possível carregar a Visão Consolidada.");
        setOverview(await overviewResponse.json() as Overview); setSummary(await summaryResponse.json() as Summary);
      }).catch((requestError: unknown) => { if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : "Não foi possível carregar a Visão Consolidada."); });
    return () => controller.abort();
  }, [retry]);
  async function setIncluded(institution: string, kind: "financial-accounts" | "credit-cards", id: string, includedInTotals: boolean) {
    setUpdating(`${kind}:${id}`);
    try {
      const response = await fetch(`/api/open-finance-connections/${encodeURIComponent(institution)}/${kind}/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ includedInTotals }) });
      if (!response.ok) throw new Error("Não foi possível atualizar os totais.");
      setRetry((value) => value + 1);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Não foi possível atualizar os totais."); }
    finally { setUpdating(""); }
  }
  if (error) return <section className="state-card" role="alert"><h2>Não foi possível carregar a Visão Consolidada</h2><p>{error}</p><button onClick={() => setRetry((value) => value + 1)}>Tentar novamente</button></section>;
  if (!overview || !summary) return <section className="state-card" role="status" aria-live="polite"><h2>Carregando Visão Consolidada</h2><p>Buscando seus dados financeiros.</p></section>;
  const institutions = overview.consolidatedView.financialInstitutions;
  if (!institutions.length) return <section className="state-card"><h2>Nenhuma Financial Institution conectada</h2><p>Conecte uma Financial Institution para visualizar Financial Accounts, Credit Cards e dados atualizados.</p><a className="button-link" href="/open-finance-connections">Abrir Open Finance Connections</a></section>;
  return <section className="consolidated-view" aria-labelledby="consolidated-view-title">
    <div className="page-title"><div><p className="eyebrow">Resumo atual</p><h1 id="consolidated-view-title">Visão Consolidada</h1></div></div>
    <dl className="totals" aria-label="Totais consolidados">
      <div><dt>Financial Accounts</dt><dd>{formatCurrency(summary.financialAccountBalance)}</dd></div>
      <div><dt>Institution Card Statements</dt><dd>{formatCurrency(summary.creditCardStatementBalance)}</dd></div>
      <div><dt>Saldo consolidado</dt><dd>{formatCurrency(summary.netBalance)}</dd></div>
    </dl>
    <ConsolidatedReports />
    <div className="institution-list">{institutions.map((institution) => {
      const dataAvailability = institution.dataAvailability ?? [
        ...(institution.financialAccounts.length ? ["Financial Accounts"] : []),
        ...(institution.institutionCardStatement?.creditCards.length ? ["Credit Cards", "Institution Card Statements"] : []),
      ];
      return <article className="institution-card" key={institution.name}>
      <header><div><h2>{institution.name}</h2><p>Data Freshness: <time dateTime={institution.dataFreshness}>{formatDate(institution.dataFreshness)}</time></p></div>{institution.consentStatus === "reconnection-required" && <p className="warning">Reconnection Required</p>}</header>
      {dataAvailability.length ? <p className="availability"><strong>Data Availability:</strong> {dataAvailability.join(", ")}</p> : null}
      <section aria-labelledby={`${institution.name}-accounts`}><h3 id={`${institution.name}-accounts`}>Financial Accounts</h3>
        {institution.financialAccounts.length ? <ul className="financial-items">{institution.financialAccounts.map((account) => <li key={account.name}><span><strong>{account.name}</strong><small>{formatCurrency(account.balance, account.currency)}</small></span><button className="secondary" disabled={updating === `financial-accounts:${account.name}`} onClick={() => setIncluded(institution.name, "financial-accounts", account.name, !account.includedInTotals)}>{account.includedInTotals ? "Excluir dos totais" : "Incluir nos totais"}</button></li>)}</ul> : <p>Nenhuma Financial Account disponível.</p>}
      </section>
      <section aria-labelledby={`${institution.name}-cards`}><h3 id={`${institution.name}-cards`}>Credit Cards</h3>
        {institution.institutionCardStatement ? <><p className="statement">Institution Card Statement: <strong>{formatCurrency(institution.institutionCardStatement.amountDue, institution.institutionCardStatement.currency)}</strong></p><ul className="financial-items">{institution.institutionCardStatement.creditCards.map((card) => <li key={card.id}><span><strong>{card.name}</strong><small>{card.statement ? `Statement: ${formatCurrency(card.statement.amountDue, card.currency)}` : "Sem statement disponível"}</small></span><button className="secondary" disabled={updating === `credit-cards:${card.id}`} onClick={() => setIncluded(institution.name, "credit-cards", card.id, card.includedInTotals === false)}>{card.includedInTotals === false ? "Incluir nos totais" : "Excluir dos totais"}</button></li>)}</ul></> : <p>Nenhum Credit Card ou Institution Card Statement disponível.</p>}
      </section>
    </article>;
    })}</div>
  </section>;
}

function OpenFinanceConnections() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [institution, setInstitution] = useState(""); const [itemId, setItemId] = useState("");
  const [loading, setLoading] = useState(false); const [creating, setCreating] = useState(false); const [synchronizing, setSynchronizing] = useState(false);
  const [error, setError] = useState(""); const [result, setResult] = useState("");

  async function load() {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/open-finance-connections");
      if (!response.ok) throw new Error("Não foi possível carregar as Open Finance Connections.");
      setConnections((await response.json() as ConnectionList).openFinanceConnections);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Não foi possível carregar as Open Finance Connections.");
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function createConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setResult("");
    if (!institution.trim()) return setError("Informe a Financial Institution.");
    if (!itemId.trim()) return setError("Informe o Meu Pluggy item ID.");
    setCreating(true);
    try {
      const response = await fetch("/api/open-finance-connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ institution: institution.trim(), itemId: itemId.trim() }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Não foi possível criar a Open Finance Connection.");
      setInstitution(""); setItemId(""); setResult("Open Finance Connection criada. Você já pode sincronizar os dados.");
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Não foi possível criar a Open Finance Connection.");
    } finally { setCreating(false); }
  }
  async function synchronize() {
    setSynchronizing(true); setError(""); setResult("Sincronização em progresso. Buscando dados das Financial Institutions.");
    try {
      const response = await fetch("/api/transactions/synchronize", { method: "POST" });
      const body = await response.json().catch(() => ({})) as { imported?: number; failedConnections?: string[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Não foi possível sincronizar agora.");
      const failures = body.failedConnections?.length ? ` ${body.failedConnections.join(", ")} requer reconexão.` : "";
      setResult(`${body.imported ?? 0} Transactions importadas.${failures}`);
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Não foi possível sincronizar agora.");
    } finally { setSynchronizing(false); }
  }
  async function changeConnection(connection: Connection, action: "disconnect" | "reconnect") {
    const name = connection.financialInstitution.name;
    const message = action === "disconnect"
      ? `Desconectar ${name}? O histórico local será preservado, mas valores atuais deixarão de integrar a Visão Consolidada.`
      : `Reconectar ${name}? Os dados atualizados serão mesclados ao histórico local preservado.`;
    if (!window.confirm(message)) return;
    setError(""); setResult("");
    try {
      const response = await fetch(`/api/open-finance-connections/${encodeURIComponent(name)}${action === "reconnect" ? "/reconnect" : ""}`, { method: action === "reconnect" ? "POST" : "DELETE" });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Não foi possível atualizar a Open Finance Connection.");
      setResult(action === "disconnect" ? "Open Finance Connection desconectada; o histórico local foi preservado." : "Open Finance Connection reconectada e atualizada.");
      await load();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Não foi possível atualizar a Open Finance Connection."); }
  }
  if (loading && !connections) return <section className="state-card" role="status"><h1>Open Finance Connections</h1><p>Carregando suas conexões.</p></section>;
  return <section className="connections-page" aria-labelledby="connections-title">
    <div className="page-title"><p className="eyebrow">Dados de instituições financeiras</p><h1 id="connections-title">Open Finance Connections</h1><p className="description">Use o item ID criado no Meu Pluggy. O dashboard só lê dados consentidos e não inicia pagamentos.</p></div>
    <section className="connection-form-card" aria-labelledby="new-connection-title"><h2 id="new-connection-title">Adicionar Open Finance Connection</h2>
      <form onSubmit={createConnection} noValidate><label htmlFor="financial-institution">Financial Institution</label><input id="financial-institution" value={institution} onChange={(event) => setInstitution(event.target.value)} />
      <label htmlFor="pluggy-item-id">Meu Pluggy item ID</label><input id="pluggy-item-id" value={itemId} onChange={(event) => setItemId(event.target.value)} />
      <p className="hint">Encontre o item ID na conexão já autorizada no Meu Pluggy. Não informe credenciais da Financial Institution.</p>
      <button type="submit" disabled={creating}>{creating ? "Adicionando…" : "Adicionar Open Finance Connection"}</button></form>
    </section>
    <div className="connection-actions"><button onClick={synchronize} disabled={synchronizing || !connections?.length}>{synchronizing ? "Sincronizando…" : "Sincronizar agora"}</button><button className="secondary" onClick={() => void load()} disabled={loading}>Atualizar lista</button></div>
    {error && <section className="state-card" role="alert"><p>{error}</p><button onClick={() => void load()}>Tentar novamente</button></section>}
    {result && <p className="message confirmation" role="status">{result}</p>}
    {!error && connections?.length === 0 && <section className="state-card"><h2>Nenhuma Open Finance Connection</h2><p>Adicione uma Financial Institution usando o item ID do Meu Pluggy para começar.</p></section>}
    <div className="connection-list">{connections?.map((connection) => <article className="institution-card" key={connection.financialInstitution.name}>
      <header><div><h2>{connection.financialInstitution.name}</h2><p>Data Freshness: <time dateTime={connection.financialInstitution.dataFreshness}>{formatDate(connection.financialInstitution.dataFreshness)}</time></p></div>{connection.consentStatus === "reconnection-required" && <p className="warning">Reconnection Required</p>}{connection.consentStatus === "disconnected" && <p className="warning">Disconnected Open Finance Connection</p>}</header>
      <p className="availability"><strong>Data Availability:</strong> {connection.dataAvailability.join(", ") || "Nenhum dado disponível"}</p>
      <p className="availability">Última sincronização: {connection.transactionsLastSynchronizedAt ? formatDate(connection.transactionsLastSynchronizedAt) : "ainda não realizada"}</p>
       {connection.consentStatus === "reconnection-required" && <p className="warning">Acesse o Meu Pluggy para renovar o consentimento antes da próxima sincronização.</p>}
       {connection.consentStatus === "disconnected" ? <><p className="warning">O histórico local foi preservado e não integra valores atuais.</p><button onClick={() => void changeConnection(connection, "reconnect")}>Reconectar</button></> : <button className="secondary" onClick={() => void changeConnection(connection, "disconnect")}>Desconectar</button>}
    </article>)}</div>
  </section>;
}

function PrivatePage({ path, navigate }: { path: string; navigate: (to: string) => void }) {
  const [loggingOut, setLoggingOut] = useState(false);
  const current = navigation.find(([to]) => to === path);
  async function logout() { setLoggingOut(true); await fetch("/api/logout", { method: "POST" }); window.location.replace("/login"); }
  return <div className="app-shell">
    <aside className="private-navigation"><p className="eyebrow">Personal Finance Dashboard</p><nav aria-label="Navegação principal">{navigation.map(([to, label]) => {
      const sharedFilters = to === "/" || to === "/spending-analysis";
      const href = `${to}${sharedFilters ? window.location.search : ""}`;
      return <a key={to} href={href} aria-current={path === to ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigate(href); }}>{label}</a>;
    })}</nav><button type="button" onClick={logout} disabled={loggingOut}>{loggingOut ? "Saindo…" : "Sair"}</button></aside>
    <main className="private-content">{path === "/" ? <ConsolidatedView /> : path === "/transactions" ? <TransactionsPage /> : path === "/transaction-categories" ? <CategoriesPage /> : path === "/spending-analysis" ? <SpendingAnalysisPage /> : path === "/open-finance-connections" ? <OpenFinanceConnections /> : current ? <section className="state-card"><h1>{current[1]}</h1><p>Esta área estará disponível em breve.</p></section> : <section className="state-card"><h1>Página não encontrada</h1><p>Escolha uma opção da navegação privada.</p></section>}</main>
  </div>;
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null); const [path, setPath] = useState(window.location.pathname);
  useEffect(() => { fetch("/api/session").then((response) => setAuthenticated(response.ok)).catch(() => setAuthenticated(false)); }, []);
  useEffect(() => { const update = () => setPath(window.location.pathname); addEventListener("popstate", update); return () => removeEventListener("popstate", update); }, []);
  function navigate(to: string) { history.pushState(null, "", to); setPath(new URL(to, window.location.origin).pathname); }
  if (authenticated === null) return <main className="login-page" role="status">Verificando sessão…</main>;
  if (!authenticated && path !== "/login") { window.location.replace(`/login?next=${encodeURIComponent(`${path}${window.location.search}`)}`); return null; }
  if (authenticated && path === "/login") { window.location.replace("/"); return null; }
  return authenticated ? <PrivatePage path={path} navigate={navigate} /> : <LoginPage />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
