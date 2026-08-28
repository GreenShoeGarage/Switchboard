import { redirect } from "next/navigation";

import { getDatabase } from "@/db";
import { installationIsConfigured } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

type SetupPageProps = { searchParams: Promise<{ error?: string }> };

export default async function SetupPage({ searchParams }: SetupPageProps) {
  if (await installationIsConfigured(getDatabase())) redirect("/login");
  const params = await searchParams;
  const suggestedUrl = process.env.SWITCHBOARD_PUBLIC_URL ?? "http://localhost:3000";
  return (
    <main className="auth-screen">
      <section className="auth-card setup-card">
        <header className="auth-brand"><span className="auth-mark">S</span><div><strong>SWITCHBOARD</strong><small>COMMUNITY / FIRST-RUN SETUP</small></div></header>
        <div className="auth-copy"><p>INSTALLATION 01</p><h1>Create the owner</h1><span>The bootstrap token comes from your private <code>.env</code> file. It is never stored in the database.</span></div>
        {params.error ? <div className="auth-error" role="alert">{params.error}</div> : null}
        <form method="post" action="/api/auth/setup" className="auth-form">
          <label>Public URL<input name="publicBaseUrl" type="url" defaultValue={suggestedUrl} required /></label>
          <label>Owner email<input name="email" type="email" autoComplete="username" required /></label>
          <label>Owner password<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /><small>Use at least 12 characters.</small></label>
          <label>Bootstrap token<input name="bootstrapToken" type="password" autoComplete="off" minLength={24} required /></label>
          <button type="submit">INITIALIZE SWITCHBOARD</button>
        </form>
        <footer>Setup is permanently disabled after the first owner is created.</footer>
      </section>
    </main>
  );
}
