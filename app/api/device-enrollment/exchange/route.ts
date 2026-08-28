import { getDatabase } from "@/db";
import { exchangeEnrollmentToken } from "@/lib/device-auth";
import { readEnrollmentRequest } from "@/lib/device-gateway";

export async function POST(request: Request) {
  try {
    const parsed = await readEnrollmentRequest(request);
    if ("response" in parsed) return parsed.response;
    const result = await exchangeEnrollmentToken(getDatabase(), parsed.payload);
    return Response.json(result, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const expected = /^(A stable hardware identifier is required|Invalid enrollment token|Enrollment token was not found|Enrollment token was revoked|Enrollment token was already used|Enrollment token expired|Hardware identifier is already registered with another board profile)$/;
    return expected.test(message)
      ? Response.json({ error: message, code: "ENROLLMENT_REJECTED" }, { status: 400, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } })
      : Response.json({ error: "Enrollment exchange failed", code: "ENROLLMENT_FAILED" }, { status: 500, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
}
