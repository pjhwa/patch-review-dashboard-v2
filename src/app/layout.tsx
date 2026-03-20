import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { cookies } from "next/headers";

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
  const theme = cookieStore.get('NEXT_THEME')?.value || 'dark';

  return (
    <html lang={locale} className={theme === 'dark' ? 'dark' : ''}>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground min-h-screen selection:bg-primary selection:text-primary-foreground`}
      >
        <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 items-end">
          <ThemeToggle currentTheme={theme} />
          <LanguageToggle currentLocale={locale} />
        </div>
        <div className="flex flex-col min-h-screen">
          <main className="flex-1">{children}</main>
          <footer className="w-full py-4 px-6 border-t border-foreground/[0.06] bg-background">
            <p className="text-center text-xs text-foreground/40 tracking-wide font-mono">
              Built with <span className="text-red-500">❤️</span> by the{" "}
              <span className="text-foreground/60 font-semibold">Cloud &amp; Infrastructure — Technical Expert Center</span>{" "}
              <span className="text-primary font-bold">(CI-TEC)</span>
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
