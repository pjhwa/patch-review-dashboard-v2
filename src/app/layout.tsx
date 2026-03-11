import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { LanguageToggle } from "@/components/LanguageToggle";
import { cookies } from "next/headers";
import Link from "next/link";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Patch Review Board",
  description: "Mission Control for Patch Review Automation",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const locale = cookieStore.get('NEXT_LOCALE')?.value || 'ko'; // Default to Korean as per user preference implied context

  return (
    <html lang={locale} className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground min-h-screen selection:bg-primary selection:text-primary-foreground`}
      >
        <nav className="space-y-2 mt-4">
          <Link href="/" className="block px-4 py-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition">Dashboard</Link>
          <Link href="/preprocessing" className="block px-4 py-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition text-amber-600 dark:text-amber-400 font-medium">Preprocessing</Link>
          <Link href="/pipeline" className="block px-4 py-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition">Pipeline / BullMQ</Link>
        </nav>
        <LanguageToggle currentLocale={locale} />
        {children}
      </body>
    </html>
  );
}
