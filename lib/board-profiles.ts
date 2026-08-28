import { z } from "zod";
import unoR4Wifi from "@/board-profiles/arduino-uno-r4-wifi.json";

const boardPinSchema = z.object({
  id: z.string().min(1), header: z.string().optional(),
  capabilities: z.array(z.string().min(1)).min(1), warnings: z.array(z.string()).optional(),
});
const boardProfileSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^[a-z0-9-]+$/),
  manufacturer: z.string().min(1), name: z.string().min(1), status: z.string(),
  agentCompatibility: z.string(), protocolVersion: z.number().int().positive(),
  primaryMcu: z.string().min(1), connectivityMcu: z.string().optional(),
  architecture: z.string().min(1), fullyQualifiedBoardName: z.string().min(1),
  flasher: z.object({ strategy: z.string(), verified: z.boolean() }),
  electrical: z.record(z.string(), z.unknown()), pins: z.array(boardPinSchema).min(1),
  sources: z.array(z.string().url()).min(1),
});

export type BoardProfile = z.infer<typeof boardProfileSchema>;
const profiles = new Map<string, BoardProfile>();
for (const candidate of [unoR4Wifi]) {
  const result = boardProfileSchema.safeParse(candidate);
  if (!result.success) throw new Error(`Invalid board profile: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  const profile = result.data;
  if (profiles.has(profile.id)) throw new Error(`Duplicate board profile: ${profile.id}`);
  if (new Set(profile.pins.map((pin) => pin.id)).size !== profile.pins.length) throw new Error(`Duplicate pin id in board profile: ${profile.id}`);
  profiles.set(profile.id, profile);
}

export function getBoardProfile(id: string) { return profiles.get(id) ?? null; }
export function listBoardProfiles() { return [...profiles.values()]; }
