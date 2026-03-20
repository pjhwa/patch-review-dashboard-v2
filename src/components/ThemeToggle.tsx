"use client";

import { useRouter } from "next/navigation";
import { Moon, Sun } from "lucide-react";

export function ThemeToggle({ currentTheme }: { currentTheme: string }) {
    const router = useRouter();

    const switchTheme = (newTheme: string) => {
        document.cookie = `NEXT_THEME=${newTheme}; path=/; max-age=31536000; SameSite=Lax`;
        router.refresh();
    };

    return (
        <div className="flex items-center gap-1 p-1 bg-white/5 backdrop-blur-md rounded-full border border-white/10 shadow-xl">
            <div className="pl-3 pr-2 text-foreground/50">
                {currentTheme === "dark" ? (
                    <Moon className="w-4 h-4" />
                ) : (
                    <Sun className="w-4 h-4" />
                )}
            </div>

            <button
                onClick={() => switchTheme("dark")}
                className={`px-3 py-1.5 text-xs font-bold font-mono rounded-full transition-all duration-300 ${
                    currentTheme === "dark"
                        ? "bg-indigo-500 text-white shadow-[0_0_15px_rgba(99,102,241,0.4)]"
                        : "text-foreground/40 hover:text-foreground/80 hover:bg-foreground/5"
                }`}
            >
                DARK
            </button>

            <button
                onClick={() => switchTheme("light")}
                className={`px-3 py-1.5 text-xs font-bold font-mono rounded-full transition-all duration-300 ${
                    currentTheme === "light"
                        ? "bg-amber-400 text-gray-900 shadow-[0_0_15px_rgba(251,191,36,0.4)]"
                        : "text-foreground/40 hover:text-foreground/80 hover:bg-foreground/5"
                }`}
            >
                DAY
            </button>
        </div>
    );
}
