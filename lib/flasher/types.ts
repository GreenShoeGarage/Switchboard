export type BoardIdentity = {
  vendorId?: number;
  productId?: number;
  profileId?: string;
  displayName: string;
  usbMode: "runtime" | "bootloader" | "unknown";
  agentVersion?: string;
  configured?: boolean;
  enrolled?: boolean;
  deviceId?: string;
};

export type FirmwarePackage = {
  boardProfile: string;
  version: string;
  protocolVersion: number;
  sha256: string;
  bytes: Uint8Array;
  verified: boolean;
  hardwareVerified: boolean;
  hilRunId: string | null;
};

export type FlashProgress = {
  phase: "detect" | "identify" | "prepare" | "flash" | "verify" | "reboot";
  completedBytes?: number;
  totalBytes?: number;
  detail: string;
};

export interface Flasher {
  detect(): Promise<boolean>;
  identify(): Promise<BoardIdentity>;
  prepare(pkg: FirmwarePackage): Promise<void>;
  flash(pkg: FirmwarePackage, report: (progress: FlashProgress) => void): Promise<void>;
  verify(pkg: FirmwarePackage): Promise<void>;
  reboot(): Promise<void>;
}

export class FlashError extends Error {
  constructor(public readonly code: "BROWSER_UNSUPPORTED" | "BOARD_MISMATCH" | "DEVICE_NOT_FOUND" | "PORT_IN_USE" | "PROGRAMMING_MODE_FAILED" | "PACKAGE_UNAVAILABLE" | "PACKAGE_NOT_VERIFIED" | "SERIAL_PERMISSION_DENIED" | "SERIAL_PROTOCOL_ERROR" | "VERIFICATION_FAILED" | "DEVICE_DISCONNECTED" | "UNSUPPORTED", message: string) {
    super(message);
    this.name = "FlashError";
  }
}
