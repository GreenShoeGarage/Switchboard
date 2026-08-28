import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { OPERATOR_EMAIL_HEADER, OPERATOR_ROLE_HEADER, type OperatorIdentity } from "@/lib/operator-auth";

export async function getOperatorUser(): Promise<OperatorIdentity | null> {
  const requestHeaders = await headers();
  const email = requestHeaders.get(OPERATOR_EMAIL_HEADER)?.trim();
  if (!email) return null;
  const role = requestHeaders.get(OPERATOR_ROLE_HEADER) as OperatorIdentity["role"] | null;
  return { id: "session", email, role: role ?? "VIEWER" };
}

export async function requireOperatorUser(returnTo: string): Promise<OperatorIdentity> {
  const user = await getOperatorUser();
  if (user) return user;
  redirect(`/login?return_to=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`);
}

export function safeRelativeReturnPath(value: string | null | undefined) {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "http://switchboard.local");
    if (url.origin !== "http://switchboard.local" || ["/login", "/setup"].includes(url.pathname)) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
