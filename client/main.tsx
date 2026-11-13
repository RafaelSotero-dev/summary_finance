import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const neutralConfirmation = "Se os dados informados estiverem cadastrados, você receberá um link de acesso por e-mail.";

function normalizeCpf(value: string) {
  return value.replace(/\D/g, "");
}

function formatCpf(value: string) {
  return normalizeCpf(value)
    .slice(0, 11)
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
}

function LoginPage() {
  const [cpf, setCpf] = useState("");
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState(() => new URLSearchParams(window.location.search).get("error") === "invalid-link" ? "Este link de acesso é inválido ou expirou. Solicite um novo link." : "");

  async function requestMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedCpf = normalizeCpf(cpf);
    if (normalizedCpf.length !== 11) return setError("Informe um CPF com 11 dígitos.");
    if (!email.trim() || !email.includes("@")) return setError("Informe um e-mail válido.");

    setSending(true);
    setError("");
    try {
      const response = await fetch("/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cpf: normalizedCpf, email: email.trim(), returnTo: new URLSearchParams(window.location.search).get("next") ?? "/" }),
      });
      if (!response.ok) throw new Error("Não foi possível solicitar o link agora.");
      setConfirmation(neutralConfirmation);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Não foi possível solicitar o link agora.");
    } finally {
      setSending(false);
    }
  }

  return <main className="login-page"><section className="login-card" aria-labelledby="login-title">
    <p className="eyebrow">Personal Finance Dashboard</p><h1 id="login-title">Entrar</h1>
    <p className="description">Informe seus dados para receber um link de acesso.</p>
    <form onSubmit={requestMagicLink} noValidate>
      <label htmlFor="cpf">CPF</label><input id="cpf" name="cpf" inputMode="numeric" autoComplete="username" value={cpf} onChange={(event) => setCpf(formatCpf(event.target.value))} aria-describedby={error ? "login-error" : undefined} />
      <label htmlFor="email">E-mail</label><input id="email" name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} aria-describedby={error ? "login-error" : undefined} />
      {error && <p id="login-error" className="message error" role="alert">{error}</p>}
      {confirmation && <p className="message confirmation" role="status">{confirmation}</p>}
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
      <button className="secondary-button" type="button" onClick={() => setEditing(null)}>Cancelar</button>
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
    {!category.archived && <><button className="secondary-button" type="button" onClick={() => onEdit(category)} aria-label={`Editar ${category.name}`}>Editar</button>
      {confirmingArchive ? <button type="button" onClick={() => void onConfirmArchive(category)}>Confirmar arquivamento</button> : <button className="secondary-button" type="button" onClick={() => onArchive(category.id)} aria-label={`Arquivar ${category.name}`}>Arquivar</button>}</>}
  </div>;
}

function PrivatePage() {
  const [loggingOut, setLoggingOut] = useState(false);
  async function logout() {
    setLoggingOut(true);
    await fetch("/api/logout", { method: "POST" });
    window.location.replace("/login");
  }
  const categoriesRoute = window.location.pathname === "/categories";
  return <main className="private-page">
    <header><p className="eyebrow">Personal Finance Dashboard</p><nav aria-label="Navegação privada"><a href="/">Visão Consolidada</a><a href="/categories">Categorias de transação</a></nav><button type="button" onClick={logout} disabled={loggingOut}>{loggingOut ? "Saindo…" : "Sair"}</button></header>
    {categoriesRoute ? <CategoriesPage /> : <section><h1>Visão Consolidada</h1><p>Seu acesso está ativo.</p></section>}
  </main>;
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const path = window.location.pathname;
  useEffect(() => {
    fetch("/api/session").then((response) => setAuthenticated(response.ok)).catch(() => setAuthenticated(false));
  }, []);

  if (authenticated === null) return <main className="login-page">Verificando sessão…</main>;
  if (!authenticated && path !== "/login") {
    window.location.replace(`/login?next=${encodeURIComponent(`${path}${window.location.search}`)}`);
    return null;
  }
  if (authenticated && path === "/login") {
    window.location.replace("/");
    return null;
  }
  return authenticated ? <PrivatePage /> : <LoginPage />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
