"use client"
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, ArrowLeft, Download } from "lucide-react";
import Link from 'next/link';

export function CategoryArchiveClient({ categoryId, dict }: { categoryId: string, dict: any }) {
    const [products, setProducts] = useState<any[]>([]);
    const [archives, setArchives] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            try {
                // Fetch products to build the tabs
                const pRes = await fetch(`/api/products?category=${categoryId}`);
                if (pRes.ok) {
                    const pData = await pRes.json();
                    setProducts(pData.products?.filter((p: any) => p.active) || []);
                }

                // Fetch total archive list
                const aRes = await fetch(`/api/pipeline/archive`);
                if (aRes.ok) {
                    const aData = await aRes.json();
                    setArchives(aData.archives || []);
                }
            } catch (e) {
                console.error("Failed to fetch archive data:", e);
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, [categoryId]);

    return (
        <div className="space-y-6 animate-in fade-in duration-500 min-h-screen">
            <div className="flex items-center gap-4">
                <Link href={`/category/${categoryId}`} className="p-2 rounded-full border border-white/5 bg-white/[0.02] hover:bg-white/10 hover:border-white/20 transition-all">
                    <ArrowLeft className="w-5 h-5 text-white/70" />
                </Link>
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white/90">
                        {categoryId === 'os' ? `OS ${dict.dashboard.categoryTitleSuffix} ` : <span className="capitalize">{categoryId} </span>}
                        {dict.dashboard.archivePage.title}
                    </h1>
                    <p className="text-white/50 text-sm mt-1 mb-2">{dict.dashboard.archivePage.subtitle}</p>
                </div>
            </div>

            {loading ? (
                <div className="flex items-center gap-3 text-emerald-400 p-8 border border-white/5 rounded-xl bg-[#080808]">
                    <Loader2 className="w-5 h-5 animate-spin" /> {dict.dashboard.archivePage.loading}
                </div>
            ) : products.length === 0 ? (
                <div className="p-12 text-center border-dashed border border-white/10 rounded-xl bg-white/[0.01]">
                    <p className="text-white/40 mb-2 font-medium">{dict.dashboard.archivePage.noProducts}</p>
                </div>
            ) : (
                <Tabs defaultValue={products[0]?.id} className="w-full">
                    <TabsList className="bg-black border border-white/10 mb-6 p-1 h-auto flex flex-wrap gap-2">
                        {products.map(prod => (
                            <TabsTrigger key={prod.id} value={prod.id} className="data-[state=active]:bg-emerald-500/20 data-[state=active]:text-emerald-400 px-6 py-2">
                                {prod.name}
                            </TabsTrigger>
                        ))}
                    </TabsList>

                    {products.map(prod => (
                        <TabsContent key={prod.id} value={prod.id} className="mt-0 space-y-4">
                            {archives.length === 0 ? (
                                <div className="p-12 text-center text-white/30 border border-dashed border-white/10 rounded-lg bg-black/50">
                                    {dict.dashboard.archivePage.noHistory}
                                    <br /><span className="text-xs mt-2 block">{dict.dashboard.archivePage.noHistorySub}</span>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pt-4">
                                    {archives.map((arc) => (
                                        <Card key={arc.id} className="relative overflow-hidden border-white/[0.06] bg-[#0a0a0a] transition-all duration-300 hover:border-white/20 hover:bg-white/[0.05] hover:shadow-[0_0_30px_-5px_rgba(255,255,255,0.05)]">
                                            <CardHeader className="pb-2 border-b border-white/5 bg-black/40">
                                                <div className="flex justify-between items-start">
                                                    <CardTitle className="text-xs font-medium text-white/50 uppercase tracking-wider">{prod.name}{dict.dashboard.archivePage.recordLabel}</CardTitle>
                                                    <Badge variant="outline" className="border-white/10 text-emerald-400/70 bg-emerald-500/5">
                                                        {new Date(arc.createdAt).toLocaleDateString()}
                                                    </Badge>
                                                </div>
                                            </CardHeader>
                                            <CardContent className="space-y-4 pt-4 relative">
                                                <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 rounded-full blur-3xl -mr-16 -mt-16 pointer-events-none"></div>

                                                <div>
                                                    <div className="text-2xl font-light tracking-tighter text-white break-all">
                                                        {new Date(arc.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                    </div>
                                                    <p className="text-[10px] text-white/30 font-mono truncate mt-1">ID: {arc.id}</p>
                                                </div>

                                                <div className="pt-2">
                                                    {arc.hasFinalCSV ? (
                                                        <a
                                                            href={`/api/pipeline/archive/${arc.id}/download?productId=${prod.id}`}
                                                            className="flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-xs font-semibold rounded-lg transition-colors border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.1)]"
                                                        >
                                                            <Download className="w-4 h-4" />
                                                            {dict.dashboard.archivePage.downloadCsv}
                                                        </a>
                                                    ) : (
                                                        <span className="block w-full text-center px-4 py-2.5 bg-white/5 text-white/30 text-xs font-semibold rounded-lg border border-white/5 cursor-not-allowed">
                                                            {dict.dashboard.archivePage.noData}
                                                        </span>
                                                    )}
                                                </div>
                                            </CardContent>
                                        </Card>
                                    ))}
                                </div>
                            )}
                        </TabsContent>
                    ))}
                </Tabs>
            )}
        </div>
    );
}
