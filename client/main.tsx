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
  name: string; dataFreshness: string; dataAvailability?: string[]; consentStatus: "active" | "reconnection-required";
  financialAccounts: FinancialAccount[]; institutionCardStatement?: { amountDue: number; currency: string; dueDate?: string; creditCards: CreditCard[] };
};
type Overview = { consolidatedView: { financialInstitutions: FinancialInstitution[] } };
type Summary = { financialAccountBalance: number; creditCardStatementBalance: number; netBalance: number };
type Connection = {
  financialInstitution: { name: string; dataFreshness: string };
  dataAvailability: string[];
  consentStatus: "active" | "reconnection-required";
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
      <header><div><h2>{connection.financialInstitution.name}</h2><p>Data Freshness: <time dateTime={connection.financialInstitution.dataFreshness}>{formatDate(connection.financialInstitution.dataFreshness)}</time></p></div>{connection.consentStatus === "reconnection-required" && <p className="warning">Reconnection Required</p>}</header>
      <p className="availability"><strong>Data Availability:</strong> {connection.dataAvailability.join(", ") || "Nenhum dado disponível"}</p>
      <p className="availability">Última sincronização: {connection.transactionsLastSynchronizedAt ? formatDate(connection.transactionsLastSynchronizedAt) : "ainda não realizada"}</p>
      {connection.consentStatus === "reconnection-required" && <p className="warning">Acesse o Meu Pluggy para renovar o consentimento antes da próxima sincronização.</p>}
    </article>)}</div>
  </section>;
}

function PrivatePage({ path, navigate }: { path: string; navigate: (to: string) => void }) {
  const [loggingOut, setLoggingOut] = useState(false);
  const current = navigation.find(([to]) => to === path);
  async function logout() { setLoggingOut(true); await fetch("/api/logout", { method: "POST" }); window.location.replace("/login"); }
  return <div className="app-shell">
    <aside className="private-navigation"><p className="eyebrow">Personal Finance Dashboard</p><nav aria-label="Navegação principal">{navigation.map(([to, label]) => <a key={to} href={to} aria-current={path === to ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigate(to); }}>{label}</a>)}</nav><button type="button" onClick={logout} disabled={loggingOut}>{loggingOut ? "Saindo…" : "Sair"}</button></aside>
    <main className="private-content">{path === "/" ? <ConsolidatedView /> : path === "/transaction-categories" ? <CategoriesPage /> : path === "/open-finance-connections" ? <OpenFinanceConnections /> : current ? <section className="state-card"><h1>{current[1]}</h1><p>Esta área estará disponível em breve.</p></section> : <section className="state-card"><h1>Página não encontrada</h1><p>Escolha uma opção da navegação privada.</p></section>}</main>
  </div>;
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null); const [path, setPath] = useState(window.location.pathname);
  useEffect(() => { fetch("/api/session").then((response) => setAuthenticated(response.ok)).catch(() => setAuthenticated(false)); }, []);
  useEffect(() => { const update = () => setPath(window.location.pathname); addEventListener("popstate", update); return () => removeEventListener("popstate", update); }, []);
  function navigate(to: string) { history.pushState(null, "", to); setPath(to); }
  if (authenticated === null) return <main className="login-page" role="status">Verificando sessão…</main>;
  if (!authenticated && path !== "/login") { window.location.replace(`/login?next=${encodeURIComponent(`${path}${window.location.search}`)}`); return null; }
  if (authenticated && path === "/login") { window.location.replace("/"); return null; }
  return authenticated ? <PrivatePage path={path} navigate={navigate} /> : <LoginPage />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
