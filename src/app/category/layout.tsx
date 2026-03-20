import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function CategoryLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <div className="min-h-screen bg-background p-6 lg:p-12 font-sans selection:bg-primary/20">
            <div className="max-w-7xl mx-auto space-y-8">
                <header className="flex flex-col gap-4">
                    <Link
                        href="/"
                        className="inline-flex items-center gap-2 text-foreground/50 hover:text-foreground transition-colors text-sm w-fit"
                    >
                        <ArrowLeft className="w-4 h-4" />
                        Back to Dashboard
                    </Link>
                </header>
                {children}
            </div>
        </div>
    );
}
