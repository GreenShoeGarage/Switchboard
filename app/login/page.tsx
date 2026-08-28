import { safeRelativeReturnPath } from "@/app/operator-auth";

export const dynamic = "force-dynamic";

type LoginPageProps = { searchParams: Promise<{ error?: string; return_to?: string }> };

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const returnTo = safeRelativeReturnPath(params.return_to);
  return (
    <main className="auth-screen">
      <section className="auth-card">
        <header className="auth-brand"><span className="auth-mark">S</span><div><strong>SWITCHBOARD</strong><small>COMMUNITY / OPERATOR ACCESS</small></div></header>
        <div className="auth-copy"><p>LOCAL CONTROL PLANE</p><h1>Sign in</h1><span>Use the owner account created during first-run setup.</span></div>
        {params.error ? <div className="auth-error" role="alert">{params.error}</div> : null}
        <form method="post" action="/api/auth/login" className="auth-form">
          <input type="hidden" name="returnTo" value={returnTo} />
          <label>Email<input name="email" type="email" autoComplete="username" required autoFocus /></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" minLength={12} maxLength={128} required /></label>
          <button type="submit">SIGN IN</button>
        </form>
        <footer>Sessions are local, revocable, and expire after seven days.</footer>
      </section>
    </main>
  );
}
