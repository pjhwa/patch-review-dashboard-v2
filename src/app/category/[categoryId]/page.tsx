import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from 'next/link';
import { headers, cookies } from 'next/headers';
import { ProductGrid } from "@/components/ProductGrid";
import { StageJSONViewer } from "@/components/StageJSONViewer";
import { getDictionary, Locale } from "@/lib/i18n";

export default async function CategoryPage({ params }: { params: Promise<{ categoryId: string }> }) {
    const { categoryId } = await params;

    const cookieStore = await cookies();
    const locale = (cookieStore.get('NEXT_LOCALE')?.value || 'ko') as Locale;
    const dict = getDictionary(locale);

    // For SSR fetching local API routes, default to localhost to avoid tunnel host resolution issues
    const port = process.env.PORT || 3000;
    const baseUrl = `http://localhost:${port}`;

    let products = [];
    try {
        const res = await fetch(`${baseUrl}/api/products?category=${categoryId}`, { cache: 'no-store' });
        if (res.ok) {
            const data = await res.json();
            products = data.products || [];
        }
    } catch (error) {
        console.error("Failed to fetch products:", error);
    }

    const isActive = products.length > 0;

    return (
        <div className="space-y-8">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h1 className="text-3xl md:text-5xl font-bold tracking-tight text-white/90">
                        {categoryId === 'os' ? `${dict.dashboard.categoryTitlePrefix}OS${dict.dashboard.categoryTitleSuffix}` : <span className="capitalize">{categoryId}{dict.dashboard.categoryTitleSuffix}</span>}
                    </h1>
                    <p className="text-white/50 text-sm md:text-base mt-2">
                        {isActive ? dict.dashboard.categorySubtitleActive : dict.dashboard.categorySubtitleInactive}
                    </p>
                </div>
                {isActive && (
                    <Link href={`/category/${categoryId}/archive`} className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-white/60 hover:text-white/90 text-sm font-medium transition-colors flex items-center gap-2">
                        {dict.dashboard.archiveHistory}
                    </Link>
                )}
            </div>

            {isActive ? (
                <ProductGrid categoryId={categoryId} products={products} dict={dict} />
            ) : (
                <div className="col-span-full py-12 text-center border border-dashed border-white/10 rounded-xl bg-white/[0.01]">
                    <p className="text-white/40">{dict.dashboard.categorySubtitleInactive}</p>
                </div>
            )}
        </div>
    );
}
