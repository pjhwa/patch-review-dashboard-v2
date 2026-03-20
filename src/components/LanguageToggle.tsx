"use client";

import { useRouter } from "next/navigation";
import { Globe } from "lucide-react";

export function LanguageToggle({ currentLocale }: { currentLocale: string }) {
    const router = useRouter();

    const switchLanguage = (newLocale: string) => {
        // Set the cookie
        document.cookie = `NEXT_LOCALE=${newLocale}; path=/; max-age=31536000; SameSite=Lax`;
        // Refresh to apply the new layout locale
        router.refresh();
    };

    return (
        <div className="flex items-center gap-1 p-1 bg-white/5 backdrop-blur-md rounded-full border border-white/10 shadow-xl">
            <div className="pl-3 pr-2 text-foreground/50">
                <Globe className="w-4 h-4" />
            </div>

            <button
                onClick={() => switchLanguage("ko")}
                className={`px-3 py-1.5 text-xs font-bold font-mono rounded-full transition-all duration-300 ${currentLocale === "ko"
                        ? "bg-emerald-500 text-white shadow-[0_0_15px_rgba(16,185,129,0.4)]"
                        : "text-foreground/40 hover:text-foreground/80 hover:bg-foreground/5"
                    }`}
            >
                KOR
            </button>

            <button
                onClick={() => switchLanguage("en")}
                className={`px-3 py-1.5 text-xs font-bold font-mono rounded-full transition-all duration-300 ${currentLocale === "en"
                        ? "bg-emerald-500 text-white shadow-[0_0_15px_rgba(16,185,129,0.4)]"
                        : "text-foreground/40 hover:text-foreground/80 hover:bg-foreground/5"
                    }`}
            >
                ENG
            </button>
        </div>
    );
}
