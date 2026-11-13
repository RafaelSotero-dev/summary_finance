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

function PrivatePage({ path, navigate }: { path: string; navigate: (to: string) => void }) {
  const [loggingOut, setLoggingOut] = useState(false);
  const current = navigation.find(([to]) => to === path);
  async function logout() { setLoggingOut(true); await fetch("/api/logout", { method: "POST" }); window.location.replace("/login"); }
  return <div className="app-shell">
    <aside className="private-navigation"><p className="eyebrow">Personal Finance Dashboard</p><nav aria-label="Navegação principal">{navigation.map(([to, label]) => <a key={to} href={to} aria-current={path === to ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigate(to); }}>{label}</a>)}</nav><button type="button" onClick={logout} disabled={loggingOut}>{loggingOut ? "Saindo…" : "Sair"}</button></aside>
    <main className="private-content">{path === "/" ? <ConsolidatedView /> : current ? <section className="state-card"><h1>{current[1]}</h1><p>Esta área estará disponível em breve.</p></section> : <section className="state-card"><h1>Página não encontrada</h1><p>Escolha uma opção da navegação privada.</p></section>}</main>
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
