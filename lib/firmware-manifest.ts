export const FIRMWARE_MANIFEST_SCHEMA = 1 as const;
export const UNO_R4_WIFI_PROFILE = "arduino-uno-r4-wifi" as const;
export const UNO_R4_WIFI_USB_IDS = [
  { vendorId: 0x2341, productId: 0x1002, mode: "runtime" },
  { vendorId: 0x2341, productId: 0x006d, mode: "bootloader" },
] as const;

export type UsbMode = "runtime" | "bootloader" | "unknown";

export type FirmwareAsset = {
  url: string;
  sha256: string;
  bytes: number;
};

export type FirmwareManifest = {
  schemaVersion: typeof FIRMWARE_MANIFEST_SCHEMA;
  release: string;
  agentVersion: string;
  protocolVersion: 1;
  board: {
    profileId: typeof UNO_R4_WIFI_PROFILE;
    fqbn: "arduino:renesas_uno:unor4wifi";
    coreVersion: string;
    usbIds: Array<{ vendorId: number; productId: number; mode: Exclude<UsbMode, "unknown"> }>;
  };
  upload: {
    strategy: "bossac-samba-extended";
    reset: "1200-bps-touch";
    bootloaderBaud: 921600;
    maximumBytes: 262144;
  };
  source: FirmwareAsset;
  binary: FirmwareAsset | null;
  hardwareVerification: {
    passed: boolean;
    hilRunId: string | null;
    verifiedAt: string | null;
  };
};

const SHA256 = /^[a-f0-9]{64}$/;

export function validateFirmwareManifest(value: unknown): FirmwareManifest {
  if (!value || typeof value !== "object") throw new Error("Firmware manifest is not an object.");
  const manifest = value as Partial<FirmwareManifest>;
  if (manifest.schemaVersion !== FIRMWARE_MANIFEST_SCHEMA) throw new Error("Unsupported firmware manifest schema.");
  if (manifest.protocolVersion !== 1) throw new Error("Firmware protocol version is not supported.");
  if (manifest.board?.profileId !== UNO_R4_WIFI_PROFILE || manifest.board.fqbn !== "arduino:renesas_uno:unor4wifi") {
    throw new Error("Firmware manifest targets a different board.");
  }
  if (manifest.upload?.strategy !== "bossac-samba-extended" || manifest.upload.reset !== "1200-bps-touch" || manifest.upload.bootloaderBaud !== 921600 || manifest.upload.maximumBytes !== 262144) {
    throw new Error("UNO R4 WiFi upload metadata is invalid.");
  }
  const usbIds = manifest.board.usbIds ?? [];
  if (!UNO_R4_WIFI_USB_IDS.every((expected) => usbIds.some((actual) => actual.vendorId === expected.vendorId && actual.productId === expected.productId && actual.mode === expected.mode))) {
    throw new Error("UNO R4 WiFi USB identifiers are incomplete.");
  }
  if (!manifest.source || !SHA256.test(manifest.source.sha256) || !manifest.source.url || !Number.isInteger(manifest.source.bytes) || manifest.source.bytes < 1) {
    throw new Error("Firmware source integrity metadata is invalid.");
  }
  if (manifest.binary && (!SHA256.test(manifest.binary.sha256) || !manifest.binary.url || !Number.isInteger(manifest.binary.bytes) || manifest.binary.bytes < 1 || manifest.binary.bytes > manifest.upload.maximumBytes)) {
    throw new Error("Firmware binary integrity metadata is invalid.");
  }
  if (!manifest.hardwareVerification || typeof manifest.hardwareVerification.passed !== "boolean") throw new Error("Hardware verification state is missing.");
  if (manifest.hardwareVerification.passed && (!manifest.binary || !manifest.hardwareVerification.hilRunId || !manifest.hardwareVerification.verifiedAt)) {
    throw new Error("Verified firmware requires a binary and Hardware-in-the-Loop evidence.");
  }
  if (!manifest.release || !manifest.agentVersion || !manifest.board.coreVersion) throw new Error("Firmware release metadata is incomplete.");
  return manifest as FirmwareManifest;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyFirmwareAsset(bytes: Uint8Array, asset: FirmwareAsset): Promise<boolean> {
  return bytes.byteLength === asset.bytes && await sha256Hex(bytes) === asset.sha256;
}

export function classifyUnoR4Usb(vendorId?: number, productId?: number): UsbMode {
  return UNO_R4_WIFI_USB_IDS.find((candidate) => candidate.vendorId === vendorId && candidate.productId === productId)?.mode ?? "unknown";
}
