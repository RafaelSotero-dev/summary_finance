import { StrictMode, useState, type FormEvent } from "react";
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
  const [error, setError] = useState("");

  async function requestMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedCpf = normalizeCpf(cpf);
    if (normalizedCpf.length !== 11) {
      setError("Informe um CPF com 11 dígitos.");
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setError("Informe um e-mail válido.");
      return;
    }

    setSending(true);
    setError("");
    try {
      const response = await fetch("/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cpf: normalizedCpf, email: email.trim() }),
      });
      if (!response.ok) throw new Error("Não foi possível solicitar o link agora.");
      setConfirmation(neutralConfirmation);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Não foi possível solicitar o link agora.");
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <p className="eyebrow">Personal Finance Dashboard</p>
        <h1 id="login-title">Entrar</h1>
        <p className="description">Informe seus dados para receber um link de acesso.</p>
        <form onSubmit={requestMagicLink} noValidate>
          <label htmlFor="cpf">CPF</label>
          <input id="cpf" name="cpf" inputMode="numeric" autoComplete="username" value={cpf} onChange={(event) => setCpf(formatCpf(event.target.value))} aria-describedby={error ? "login-error" : undefined} />
          <label htmlFor="email">E-mail</label>
          <input id="email" name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} aria-describedby={error ? "login-error" : undefined} />
          {error && <p id="login-error" className="message error" role="alert">{error}</p>}
          {confirmation && <p className="message confirmation" role="status">{confirmation}</p>}
          <button type="submit" disabled={sending}>{sending ? "Enviando…" : "Enviar link de acesso"}</button>
        </form>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LoginPage />
  </StrictMode>,
);
