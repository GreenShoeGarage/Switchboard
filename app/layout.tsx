import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SWITCHBOARD — Microcontroller Command Workbench",
  description: "A serious browser workbench for provisioning, monitoring, and controlling network-capable microcontrollers.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
